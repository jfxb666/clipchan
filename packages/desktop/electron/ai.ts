/**
 * AI 能力的主进程实现（spec §8 / 计划 Task 5 Step 4）。
 *
 * ★ 边界（Review Focus 6）：Key 只在主进程内存与数据库之间流动，**永不出现在返回值里**；
 *   上行的 apiKey 写完就丢，回读一律换成 keyMask。
 * ★ 依赖注入（{ kv, adapterFor, optimize }）：本模块顶层不 import electron，
 *   所以 ai.spec.ts 能直接跑（不 import electron，就不会在 node 下炸）。
 */
import { randomUUID } from 'node:crypto';
import { BUILTIN_SCENES, DEFAULT_TIMEOUT_MS, assistActionById, sceneById, toAiError } from '@clipchan/ai';
import type { AiProtocol, AssistInput, AssistResult, OptimizeInput, OptimizeResult, ProviderAdapter, ProviderConfig } from '@clipchan/ai';
import type { AiError, AiProvider, AiProviderInput, AssistRequest, CustomAction, CustomActionInput, OptimizeRequest } from '@clipchan/core';
import { CH } from './channels';
import { needsSealing } from './keyvault';
import type { SecretBox } from './keyvault';

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
  assist: (adapter: ProviderAdapter, cfg: ProviderConfig, key: string, input: AssistInput) => Promise<AssistResult>;
  /** provider 增删改后通知界面重取列表（默认不广播，测试里可注入 spy）。 */
  onChanged?: () => void;
  /** 流式增量：把 (requestId, 已可展示文本) 交给 main.ts 广播；不注入则退回整段返回。 */
  onDelta?: (requestId: string, text: string) => void;
  /** 请求收尾（成功或失败都会调）：让节流器把最后一段发出去并清表。 */
  onDeltaEnd?: (requestId: string) => void;
  /**
   * 可选：Key 的加密保险箱（升级项 ①）。由 main.ts 注入 DPAPI 实现。
   * ★ 不注入时行为与升级前**完全一致**（明文直读直写）—— 这样 ai.spec.ts 的既有用例
   *   语义不变，而主进程走加密。渲染层拿到的仍然是 keyMask，与加不加密无关。
   */
  secretBox?: SecretBox;
}

/** provider 元数据在 KV 里的键；Key 拆成 aiKey:<providerId> 单独放。 */
export const PROVIDERS_KEY = 'aiProviders';
export const keyKey = (id: string): string => 'aiKey:' + id;

/**
 * 自定义 AI 动作（v1.2 D1）在 KV 里的键，与 aiProviders 同款 getSettingValue/setSettingValue 读写。
 * ★ 注释（计划原文）：不能进 Settings 类型，否则 sanitizeSettings 会把它剥掉——
 *   Settings 的清洗只认类型里声明过的键，KV 直存的键必须绕开那一层。
 */
export const CUSTOM_ACTIONS_KEY = 'aiCustomActions';

/** 上限：12 条、name ≤12 字、prompt ≤2000 字符。与 ai 包 CUSTOM_PROMPT_MAX_CODEPOINTS、core 的 ui/customActions.ts 同一口径，三处别各改各的。 */
export const CUSTOM_ACTIONS_MAX = 12;
export const CUSTOM_NAME_MAX_CODEPOINTS = 12;
export const CUSTOM_PROMPT_MAX_CODEPOINTS = 2000;

/** 按码点数长度：中文与 emoji 都不会被数成半个（与 db 层的标签截断同一考虑）。 */
function codepointLength(s: string): number {
  return [...s].length;
}

/**
 * 清洗自定义动作列表（读 KV 用）：单条损坏只丢这条，不让整个列表消失（与 readProviders 的降级路径同一考虑）。
 * ★ 写入前 saveCustomAction 自己再做严格校验（超限抛中文错）；这里是「库里已经有的数据」的兜底，
 *   坏行直接跳过而不是抛——列表读不出来会把设置页与助手面板一起拖崩。
 */
export function sanitizeCustomActions(raw: unknown): CustomAction[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomAction[] = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : '';
    if (id === '' || name === '' || prompt === '') continue;
    if (codepointLength(name) > CUSTOM_NAME_MAX_CODEPOINTS) continue;
    if (codepointLength(prompt) > CUSTOM_PROMPT_MAX_CODEPOINTS) continue;
    out.push({ id, name, prompt });
    // 条数上限在这里也兜一次：库里被手工塞爆时只取前 12 条。
    if (out.length >= CUSTOM_ACTIONS_MAX) break;
  }
  return out;
}

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

/**
 * 把库里那条记录翻译成明文 Key（只留在主进程内存里）。
 *
 * ★ 解不开（换机器/换用户拷来的库、DPAPI 拒绝）不能把整个 provider 列表带崩：
 *   记一条警告、当作「没有 Key」，界面表现为 hasKey=false、点测试报缺 Key。
 */
function openKey(box: SecretBox, stored: string, id: string): string {
  try {
    return box.open(stored);
  } catch (e) {
    console.warn('[ai] provider ' + id + ' 的 Key 解不开，按未配置处理：' + String(e));
    return '';
  }
}

function readKey(kv: AiKv, id: string, box?: SecretBox): string {
  const raw = kv.getSettingValue(keyKey(id));
  if (typeof raw !== 'string' || raw === '') return '';
  // ★ 没注入保险箱 = 升级前的行为：库里是什么就用什么（测试替身与老路径都走这条）。
  if (!box) return raw;
  const plain = openKey(box, raw, id);
  if (plain === '') return '';
  // ★ 明文迁移：读到历史遗留明文就就地加密回写（升级项 ① 的存量 Key 迁移）。
  //   判据「不是密文」（含 plain:v1:）→ 等系统加密恢复可用后，降级值也会被升级。
  //   幂等：写回前先比对，seal 结果与库里的值一样（加密不可用时就是这种情况）就不写。
  //   失败不致命：写回抛异常只记警告，本次调用照样把明文交出去。
  if (needsSealing(raw)) {
    try {
      const sealed = box.seal(plain);
      if (sealed !== '' && sealed !== raw) kv.setSettingValue(keyKey(id), sealed);
    } catch (e) {
      console.warn('[ai] provider ' + id + ' 的 Key 迁移加密失败（继续用明文）：' + String(e));
    }
  }
  return plain;
}

function toPublic(kv: AiKv, cfg: StoredProvider, box?: SecretBox): AiProvider {
  const key = readKey(kv, cfg.id, box);
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
  assist(req: AssistRequest): Promise<AssistResult>;
  /** 自定义 AI 动作（v1.2 D1）：列表/新增或覆盖/删除，写操作回变更后的整表（与 snippets 同范式）。 */
  listCustomActions(): Promise<CustomAction[]>;
  saveCustomAction(input: CustomActionInput): Promise<CustomAction[]>;
  removeCustomAction(id: string): Promise<CustomAction[]>;
  /** 中断在途请求（按 requestId）；没有在途请求时静默返回（重复点「停止」不该报错）。 */
  cancel(requestId: string): Promise<void>;
  scenes(): Promise<{ id: string; name: string; description: string }[]>;
  /** IPC 处理器表片段（main.ts 直接展开进 buildHandlers 的表里）。 */
  handlers(): Record<string, (event: unknown, ...args: any[]) => unknown>;
}

/**
 * 造 ai 面的七个方法 + 对应的 IPC 处理器。
 * @param deps 依赖注入；onChanged 由 main.ts 传 broadcaster.aiChanged。
 */
export function createAi(deps: AiDeps): AiApi {
  const { kv, adapterFor, optimize, assist, onChanged, onDelta, onDeltaEnd, secretBox } = deps;

  const list = (): AiProvider[] => readProviders(kv).map((cfg) => toPublic(kv, cfg, secretBox));

  /**
   * 在途请求的取消器：requestId → AbortController。
   *
   * ★ 只在内存里：进程重启就没有在途请求了，没必要持久化。
   * ★ 用 requestId 而不是 providerId 做键：同一个 provider 可以并发两次优化。
   */
  const inflight = new Map<string, AbortController>();
  const changed = (): void => {
    if (onChanged) onChanged();
  };

  /** 取 provider 与其 Key；没有就抛中文错误（绝不用 undefined 伪造结果）。 */
  const requireProvider = (id: string): { cfg: StoredProvider; key: string } => {
    const cfg = readProviders(kv).find((p) => p.id === id);
    if (!cfg) throw err(NO_PROVIDER);
    return { cfg, key: readKey(kv, id, secretBox) };
  };

  const api: AiApi = {
    listProviders: async () => list(),

    // ── 自定义 AI 动作（v1.2 D1）───────────────────────────────────────────────
    // KV 直存（CUSTOM_ACTIONS_KEY），不走 Settings：见 CUSTOM_ACTIONS_KEY 处的 ★ 注释。

    listCustomActions: async () => sanitizeCustomActions(kv.getSettingValue(CUSTOM_ACTIONS_KEY)),

    saveCustomAction: async (incoming) => {
      const input = incoming ?? ({} as CustomActionInput);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      // ★ 超限抛中文错误而不是静默截断：设置页有同规则的客户端校验，走到这里的超限值
      //   只可能是绕过界面直调 IPC 的，明确拒绝比悄悄改写更诚实。
      if (name === '') throw err('动作名称不能为空');
      if (codepointLength(name) > CUSTOM_NAME_MAX_CODEPOINTS) throw err('动作名称不能超过 12 个字');
      if (prompt === '') throw err('提示词不能为空');
      if (codepointLength(prompt) > CUSTOM_PROMPT_MAX_CODEPOINTS) throw err('提示词不能超过 2000 个字符');
      const rows = sanitizeCustomActions(kv.getSettingValue(CUSTOM_ACTIONS_KEY));
      // id 口径与 folders 一致：randomUUID 去横线。
      const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : randomUUID().replace(/-/g, '');
      const next: CustomAction = { id, name, prompt };
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) {
        rows[at] = next;
      } else {
        if (rows.length >= CUSTOM_ACTIONS_MAX) throw err('自定义动作最多 ' + CUSTOM_ACTIONS_MAX + ' 条，请先删除一条再添加');
        rows.push(next);
      }
      kv.setSettingValue(CUSTOM_ACTIONS_KEY, rows);
      return rows;
    },

    removeCustomAction: async (id) => {
      const target = String(id);
      const rows = sanitizeCustomActions(kv.getSettingValue(CUSTOM_ACTIONS_KEY)).filter((r) => r.id !== target);
      kv.setSettingValue(CUSTOM_ACTIONS_KEY, rows);
      return rows;
    },

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
      // ★ 有保险箱就落密文（enc:v1:，系统加密不可用时是 plain:v1:，由 seal 诚实降级）；
      //   没有保险箱则原样落明文，与升级前一致。
      if (typeof incoming.apiKey === 'string' && incoming.apiKey !== '') {
        kv.setSettingValue(keyKey(id), secretBox ? secretBox.seal(incoming.apiKey) : incoming.apiKey);
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
        return await adapterFor(cfg.protocol).test(cfg, readKey(kv, id, secretBox));
      } catch (e) {
        return { ok: false, error: toAiError(e, { timeoutMs: DEFAULT_TIMEOUT_MS }) };
      }
    },

    optimize: async (req) => {
      const { cfg, key } = requireProvider(req.providerId);
      const scene = sceneById(req.sceneId);
      if (!scene) throw err('未知的优化场景：' + req.sceneId);
      // 只有"有 onDelta 且有 requestId"才走流式增量；否则退回整段返回（界面照样能显示结果）。
      const canStream = typeof onDelta === 'function' && typeof req.requestId === 'string' && req.requestId !== '';
      const rid = typeof req.requestId === 'string' ? req.requestId : '';
      const ctrl = new AbortController();
      if (rid !== '') inflight.set(rid, ctrl);
      try {
        // 场景规则由 buildMetaPrompt 注入，这层只做"取 Key + 选适配器"。
        return await optimize(adapterFor(cfg.protocol), cfg, key, {
          text: req.text,
          scene,
          mode: req.mode,
          extra: req.extra,
          signal: ctrl.signal,
          // ★ 增量只带 requestId 与"已可展示"的成品文本：渲染层按 id 配对，过期即丢。
          //   requestId 为空时不接 onPreview：没有配对键的增量发出去只会被界面当过期丢掉。
          onPreview: canStream ? (preview: string) => onDelta!(req.requestId, preview) : undefined,
        });
      } catch (e) {
        // ★ 抛结构化错误给渲染层（它只认 kind/status/message）。
        throw toAiError(e, { timeoutMs: DEFAULT_TIMEOUT_MS });
      } finally {
        if (rid !== '') inflight.delete(rid);
        // 成功失败都要收尾：否则节流器里的最后一段永远发不出去（用户看到的是半截）。
        if (onDeltaEnd) onDeltaEnd(req.requestId);
      }
    },

    assist: async (req) => {
      const text = typeof req.text === 'string' ? req.text : '';
      if (text.trim() === '') throw err('没有可处理的文本');
      // ★ targetLang 只对 translate 有意义：其余动作即使 req 带了也不往下传，
      //   否则提示词里会冒出一句「翻译成 X」污染总结/改写。extra 同理，空白等于没传。
      const targetLang = typeof req.targetLang === 'string' ? req.targetLang.trim() : '';
      const extra = typeof req.extra === 'string' ? req.extra.trim() : '';
      const rawAction = String(req.action);
      const builtin = assistActionById(rawAction);
      let input: AssistInput;
      if (rawAction === 'custom') {
        // v1.2 D1：'custom' 是白名单之外唯一放行的动作——它是用户固化的提示词，
        // 走同一条 assist 流水线；提示词缺失在这里先拦（渲染层拿到的是看得懂的中文错误），
        // ai 包 buildAssistMessages 里还有同一规则的兜底。
        const prompt = typeof req.custom?.prompt === 'string' ? req.custom.prompt.trim() : '';
        if (prompt === '') throw err('自定义动作缺少提示词');
        input = {
          action: 'custom',
          text,
          custom: { name: typeof req.custom?.name === 'string' ? req.custom.name.trim() : '', prompt },
        };
      } else {
        // ★ 动作是白名单：界面按 ASSIST_ACTIONS 出菜单，认不出就是调用方传错了，别让它落到提示词里。
        if (!builtin) throw err('不认识的 AI 动作：' + req.action);
        input = {
          action: builtin.id,
          text,
          ...(builtin.needsTargetLang && targetLang !== '' ? { targetLang } : {}),
          ...(extra !== '' ? { extra } : {}),
        };
      }
      const { cfg, key } = requireProvider(req.providerId);
      try {
        const r = await assist(adapterFor(cfg.protocol), cfg, key, input);
        // ★ degraded 必须透传：界面要靠它提示"模型没按格式来，正文是兜底"。
        return { text: r.text, degraded: r.degraded };
      } catch (e) {
        throw toAiError(e, { timeoutMs: DEFAULT_TIMEOUT_MS });
      }
    },

    cancel: async (requestId) => {
      const rid = typeof requestId === 'string' ? requestId : '';
      if (rid === '') return;
      const ctrl = inflight.get(rid);
      if (!ctrl) return;
      inflight.delete(rid);
      ctrl.abort();
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
        [CH.ai.assist]: (_e: unknown, req: AssistRequest) => api.assist(req),
        [CH.ai.customActions]: () => api.listCustomActions(),
        [CH.ai.saveCustomAction]: (_e: unknown, input: CustomActionInput) => api.saveCustomAction(input),
        [CH.ai.removeCustomAction]: (_e: unknown, id: string) => api.removeCustomAction(String(id)),
        [CH.ai.cancel]: (_e: unknown, requestId: string) => api.cancel(String(requestId)),
        [CH.ai.scenes]: () => api.scenes(),
      };
    },
  };

  return api;
}
