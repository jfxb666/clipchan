/**
 * AI 能力的主进程实现（spec §8 / 计划 Task 5 Step 4）。
 *
 * ★ 边界（Review Focus 6）：Key 只在主进程内存与数据库之间流动，**永不出现在返回值里**；
 *   上行的 apiKey 写完就丢，回读一律换成 keyMask。
 * ★ 依赖注入（{ kv, adapterFor, optimize }）：本模块顶层不 import electron，
 *   所以 ai.spec.ts 能直接跑（不 import electron，就不会在 node 下炸）。
 */
import { randomUUID } from 'node:crypto';
import { BUILTIN_SCENES, DEFAULT_TIMEOUT_MS, sceneById, toAiError } from '@clipchan/ai';
import type { AiProtocol, OptimizeInput, OptimizeResult, ProviderAdapter, ProviderConfig } from '@clipchan/ai';
import type { AiError, AiProvider, AiProviderInput, OptimizeRequest } from '@clipchan/core';
import { CH } from './channels';

/** 主进程能用的最小 KV 访问面（db.ts 的 getSettingValue / setSettingValue）。 */
export interface AiKv {
  getSettingValue<T = unknown>(key: string): T | undefined;
  setSettingValue(key: string, value: unknown): void;
}

/** ★ 只注入这三个（计划 Step 4 原文）：不给 electron、不给实现细节，方便测试替身。 */
export interface AiDeps {
  kv: AiKv;
  adapterFor: (protocol: AiProtocol) => ProviderAdapter;
  optimize: (adapter: ProviderAdapter, cfg: ProviderConfig, key: string, input: OptimizeInput) => Promise<OptimizeResult>;
  /** provider 增删改后通知界面重取列表（默认不广播，测试里可注入 spy）。 */
  onChanged?: () => void;
}

/** provider 元数据在 KV 里的键；Key 拆成 aiKey:<providerId> 单独放。 */
export const PROVIDERS_KEY = 'aiProviders';
export const keyKey = (id: string): string => 'aiKey:' + id;

const PROTOCOLS: AiProtocol[] = ['openai-compat', 'anthropic', 'gemini'];
const NO_PROVIDER = '请先在设置里添加 AI 模型';
const MASK = '••••';
const err = (message: string): AiError => toAiError(new Error(message), { timeoutMs: DEFAULT_TIMEOUT_MS });

/** Key 掩码：只露头 3 尾 4；太短就整体遮掉（宁可少露）。 */
export function maskKey(key: string): string {
  return key.length < 8 ? MASK : key.slice(0, 3) + '…' + key.slice(-4);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asText(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw err(field + ' 不能为空');
  return v.trim();
}

function asProtocol(v: unknown): AiProtocol {
  if (typeof v === 'string' && (PROTOCOLS as string[]).includes(v)) return v as AiProtocol;
  throw err('不支持的协议：' + String(v));
}

/** KV 里存的元数据（ProviderConfig 不含 Key）。 */
type StoredProvider = ProviderConfig;

function readProviders(kv: AiKv): StoredProvider[] {
  const raw = kv.getSettingValue(PROVIDERS_KEY);
  if (!Array.isArray(raw)) return [];
  const out: StoredProvider[] = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    // 单条损坏只丢这条，不让整个列表消失（Review Focus 2 的降级路径）。
    try {
      out.push({
        id: asText(row.id, 'id'),
        name: asText(row.name, 'name'),
        protocol: asProtocol(row.protocol),
        baseUrl: asText(row.baseUrl, 'baseUrl'),
        model: asText(row.model, 'model'),
      });
    } catch {
      continue;
    }
  }
  return out;
}

function readKey(kv: AiKv, id: string): string {
  const raw = kv.getSettingValue(keyKey(id));
  return typeof raw === 'string' ? raw : '';
}

function toPublic(kv: AiKv, cfg: StoredProvider): AiProvider {
  const key = readKey(kv, cfg.id);
  // ★ 必须逐字段手写：写成 { ...cfg, apiKey: key } 就是泄密（Review Focus 6）。
  return {
    id: cfg.id,
    name: cfg.name,
    protocol: cfg.protocol,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: key !== '',
    keyMask: key === '' ? MASK : maskKey(key),
  };
}

export interface AiApi {
  listProviders(): Promise<AiProvider[]>;
  saveProvider(p: AiProviderInput): Promise<AiProvider[]>;
  removeProvider(id: string): Promise<AiProvider[]>;
  listModels(id: string): Promise<string[]>;
  test(id: string): Promise<{ ok: boolean; error?: AiError; model?: string }>;
  optimize(req: OptimizeRequest): Promise<OptimizeResult>;
  scenes(): Promise<{ id: string; name: string; description: string }[]>;
  /** IPC 处理器表片段（main.ts 直接展开进 buildHandlers 的表里）。 */
  handlers(): Record<string, (event: unknown, ...args: any[]) => unknown>;
}

/**
 * 造 ai 面的七个方法 + 对应的 IPC 处理器。
 * @param deps 依赖注入；onChanged 由 main.ts 传 broadcaster.aiChanged。
 */
export function createAi(deps: AiDeps): AiApi {
  const { kv, adapterFor, optimize, onChanged } = deps;

  const list = (): AiProvider[] => readProviders(kv).map((cfg) => toPublic(kv, cfg));
  const changed = (): void => {
    if (onChanged) onChanged();
  };

  /** 取 provider 与其 Key；没有就抛中文错误（绝不用 undefined 伪造结果）。 */
  const requireProvider = (id: string): { cfg: StoredProvider; key: string } => {
    const cfg = readProviders(kv).find((p) => p.id === id);
    if (!cfg) throw err(NO_PROVIDER);
    return { cfg, key: readKey(kv, id) };
  };

  const api: AiApi = {
    listProviders: async () => list(),

    saveProvider: async (p) => {
      const incoming = p ?? ({} as AiProviderInput);
      const protocol = asProtocol(incoming.protocol);
      const rows = readProviders(kv);
      const id = typeof incoming.id === 'string' && incoming.id !== '' ? incoming.id : 'p_' + randomUUID();
      const next: StoredProvider = {
        id,
        name: asText(incoming.name, 'name'),
        protocol,
        baseUrl: asText(incoming.baseUrl, 'baseUrl'),
        model: asText(incoming.model, 'model'),
      };
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows[at] = next;
      else rows.push(next);
      kv.setSettingValue(PROVIDERS_KEY, rows);
      // ★ 没传 apiKey = 编辑时不改 Key（否则改个名字就把 Key 清了）。
      if (typeof incoming.apiKey === 'string' && incoming.apiKey !== '') {
        kv.setSettingValue(keyKey(id), incoming.apiKey);
      }
      changed();
      return list();
    },

    removeProvider: async (id) => {
      kv.setSettingValue(
        PROVIDERS_KEY,
        readProviders(kv).filter((r) => r.id !== id),
      );
      kv.setSettingValue(keyKey(id), null);
      changed();
      return list();
    },

    listModels: async (id) => {
      const { cfg, key } = requireProvider(id);
      try {
        return await adapterFor(cfg.protocol).listModels(cfg, key);
      } catch (e) {
        throw toAiError(e, { timeoutMs: DEFAULT_TIMEOUT_MS });
      }
    },

    test: async (id) => {
      const cfg = readProviders(kv).find((p) => p.id === id);
      if (!cfg) return { ok: false, error: err(NO_PROVIDER) };
      try {
        return await adapterFor(cfg.protocol).test(cfg, readKey(kv, id));
      } catch (e) {
        return { ok: false, error: toAiError(e, { timeoutMs: DEFAULT_TIMEOUT_MS }) };
      }
    },

    optimize: async (req) => {
      const { cfg, key } = requireProvider(req.providerId);
      const scene = sceneById(req.sceneId);
      if (!scene) throw err('未知的优化场景：' + req.sceneId);
      try {
        // 场景规则由 buildMetaPrompt 注入，这层只做"取 Key + 选适配器"。
        return await optimize(adapterFor(cfg.protocol), cfg, key, {
          text: req.text,
          scene,
          mode: req.mode,
          extra: req.extra,
        });
      } catch (e) {
        // ★ 抛结构化错误给渲染层（它只认 kind/status/message）。
        throw toAiError(e, { timeoutMs: DEFAULT_TIMEOUT_MS });
      }
    },

    // 只投影三字段：rules 与 example 留在主进程。
    scenes: async () => BUILTIN_SCENES.map((s) => ({ id: s.id, name: s.name, description: s.description })),

    handlers() {
      return {
        [CH.ai.listProviders]: () => api.listProviders(),
        [CH.ai.saveProvider]: (_e: unknown, p: AiProviderInput) => api.saveProvider(p),
        [CH.ai.removeProvider]: (_e: unknown, id: string) => api.removeProvider(String(id)),
        [CH.ai.listModels]: (_e: unknown, id: string) => api.listModels(String(id)),
        [CH.ai.test]: (_e: unknown, id: string) => api.test(String(id)),
        [CH.ai.optimize]: (_e: unknown, req: OptimizeRequest) => api.optimize(req),
        [CH.ai.scenes]: () => api.scenes(),
      };
    },
  };

  return api;
}
