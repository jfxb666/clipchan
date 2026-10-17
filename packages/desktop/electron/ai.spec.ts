/**
 * AI 主进程桥的用例（计划 Task 5 Step 7）。
 *
 * ★ 全部走依赖注入：不 import electron、不联网，跑在 node 里。
 * ★ 重点盯两件事：通道一个都没漏（Review Focus 8）、Key 一个字都不外泄（Review Focus 6/7）。
 */
import { describe, expect, it, vi } from 'vitest';
import { optimize as runOptimize } from '@clipchan/ai';
import type { ProviderAdapter, ProviderConfig } from '@clipchan/ai';
import type { AiProvider, AiProviderInput } from '@clipchan/core';
import { ALL_INVOKE_CHANNELS, CH, EV } from './channels';
import { PROVIDERS_KEY, createAi, keyKey, maskKey } from './ai';
import type { AiKv } from './ai';

const FULL_KEY = 'sk-ant-api03-abcdefghijklmnop';

/** 内存 KV：形状与 db.ts 的两个访问器逐字一致。 */
function fakeKv(seed: Record<string, unknown> = {}): AiKv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    store,
    getSettingValue<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    setSettingValue(key: string, value: unknown): void {
      store.set(key, value);
    },
  };
}

/** 假适配器：只回一段合法格式，不上网。 */
function fakeAdapter(): ProviderAdapter & { chatCalls: number } {
  const adapter = {
    chatCalls: 0,
    async chat(_cfg: ProviderConfig, _key: string): Promise<string> {
      adapter.chatCalls += 1;
      return '<optimized>你是资深编辑，请把这段改清楚。</optimized>\n<notes>- 补了角色</notes>';
    },
    async listModels(): Promise<string[]> {
      return ['fake-model'];
    },
    async test(): Promise<{ ok: true; model: string }> {
      return { ok: true, model: 'fake-model' };
    },
  };
  return adapter;
}

function makeAi(seed: Record<string, unknown> = {}) {
  const kv = fakeKv(seed);
  const adapter = fakeAdapter();
  const onChanged = vi.fn();
  const api = createAi({
    kv,
    adapterFor: () => adapter,
    // ★ 用真的 optimize（含 buildMetaPrompt + parseOptimized），只把网络那层换掉。
    optimize: runOptimize,
    onChanged,
  });
  return { api, kv, adapter, onChanged };
}

const row = (over: Partial<AiProviderInput> = {}): AiProviderInput => ({
  id: 'p1',
  name: 'Claude',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-5',
  ...over,
});

describe('ai IPC 主进程桥', () => {
  it('七个 ai 通道全在 ALL_INVOKE_CHANNELS 里，aiChanged 只在 EV 里', () => {
    for (const c of Object.values(CH.ai)) expect(ALL_INVOKE_CHANNELS).toContain(c);
    expect(ALL_INVOKE_CHANNELS).not.toContain(EV.aiChanged);
    // 反过来也要成立：注册表里多出来的通道就是没人调的（Review Focus 8）。
    expect(ALL_INVOKE_CHANNELS.filter((c) => c.startsWith('ai:'))).toHaveLength(Object.keys(CH.ai).length);
  });

  it('listProviders 只回掩码：对象没有 apiKey 字段，序列化里也没有完整 Key', async () => {
    const { api, kv } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    // 库里的确有明文（Key 只在主进程与库之间流动）。
    expect(kv.getSettingValue(keyKey('p1'))).toBe(FULL_KEY);

    const list = await api.listProviders();
    expect(list).toHaveLength(1);
    const p = list[0] as AiProvider;
    expect(p).not.toHaveProperty('apiKey');
    expect(Object.prototype.hasOwnProperty.call(p, 'apiKey')).toBe(false);
    expect(p.hasKey).toBe(true);
    expect(p.keyMask).toBe(maskKey(FULL_KEY));
    expect(p.keyMask).toBe('sk-…mnop');
    expect(JSON.stringify(list)).not.toContain(FULL_KEY);
  });

  it('saveProvider 不传 apiKey 时保留原 Key（编辑改名字不会把 Key 清掉）', async () => {
    const { api, kv } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    const list = await api.saveProvider(row({ name: 'Claude（改个名）' }));
    expect(kv.getSettingValue(keyKey('p1'))).toBe(FULL_KEY);
    expect(list[0]!.name).toBe('Claude（改个名）');
    expect(list[0]!.hasKey).toBe(true);
  });

  it('optimize 在没有 provider 时抛中文错误，不返回 undefined', async () => {
    const { api, onChanged } = makeAi();
    await expect(
      api.optimize({ providerId: 'missing', text: '帮我写个周报', sceneId: 'general', mode: 'user' }),
    ).rejects.toThrow('请先在设置里添加 AI 模型');
    // 没配 provider 时不该广播，也不该假装成功。
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('镜像类型不漂移：ai 包 ProviderConfig 的五个字段都在 core 的 AiProvider 上', async () => {
    const { api } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    const p = (await api.listProviders())[0] as unknown as Record<string, unknown>;
    const cfg: ProviderConfig = { id: 'x', name: 'x', protocol: 'anthropic', baseUrl: 'https://a/v1', model: 'm' };
    for (const field of Object.keys(cfg)) {
      expect(Object.prototype.hasOwnProperty.call(p, field), 'core 的 AiProvider 缺字段 ' + field).toBe(true);
    }
    // 协议三值两边必须一致，否则界面选得出、主进程认不出。
    expect(p.protocol).toBe('anthropic');
    expect(PROVIDERS_KEY).toBe('aiProviders');
  });
});
