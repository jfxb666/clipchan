/**
 * AI 主进程桥的用例（计划 Task 5 Step 7）。
 *
 * ★ 全部走依赖注入：不 import electron、不联网，跑在 node 里。
 * ★ 重点盯两件事：通道一个都没漏（Review Focus 8）、Key 一个字都不外泄（Review Focus 6/7）。
 */
import { describe, expect, it, vi } from 'vitest';
import { optimize as runOptimize } from '@clipchan/ai';
import type { AssistInput, AssistResult, ProviderAdapter, ProviderConfig } from '@clipchan/ai';
import type { AiProvider, AiProviderInput } from '@clipchan/core';
import { ALL_INVOKE_CHANNELS, CH, EV } from './channels';
import { PROVIDERS_KEY, createAi, keyKey, maskKey } from './ai';
import type { AiDeps, AiKv } from './ai';
import { ENC_PREFIX, createSecretBox } from './keyvault';
import type { SecretCrypto } from './keyvault';

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
    // 流式替身：整段一次性回，把 reply 当唯一一块增量交出去（真实适配器是逐块）。
    async chatStream(
      _cfg: ProviderConfig,
      _key: string,
      _messages: unknown,
      opts?: { onDelta?: (delta: string) => void },
    ): Promise<string> {
      adapter.chatCalls += 1;
      const reply = '<optimized>你是资深编辑，请把这段改清楚。</optimized>\n<notes>- 补了角色</notes>';
      if (opts?.onDelta) opts.onDelta(reply);
      return reply;
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

/** 假适配器：一直挂着，直到 signal 被 abort（用来测「停止」）。 */
function hangingAdapter() {
  return {
    async chat(): Promise<string> {
      throw new Error('这条用例只走流式');
    },
    chatStream(
      _cfg: ProviderConfig,
      _key: string,
      _messages: unknown,
      opts?: { signal?: AbortSignal },
    ): Promise<string> {
      return new Promise<string>((_resolve, reject) => {
        const signal = opts?.signal;
        if (!signal) {
          reject(new Error('用例必须传 signal'));
          return;
        }
        if (signal.aborted) {
          reject(new Error('已中止'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('已中止')), { once: true });
      });
    },
    async listModels(): Promise<string[]> {
      return ['fake-model'];
    },
    async test(): Promise<{ ok: true; model: string }> {
      return { ok: true, model: 'fake-model' };
    },
  } as unknown as ProviderAdapter;
}

/** 假加密（升级项 ①）：可逆、与原文不同形，够验证「库里不是明文」。 */
function fakeCrypto(over: Partial<SecretCrypto> = {}): SecretCrypto {
  return {
    available: () => true,
    encrypt: (plain: string) => Buffer.from('x' + plain, 'utf8').toString('base64'),
    decrypt: (cipher: string) => {
      const plain = Buffer.from(cipher, 'base64').toString('utf8');
      if (!plain.startsWith('x')) throw new Error('不是本实现产的密文');
      return plain.slice(1);
    },
    ...over,
  };
}

/** 假 assist：默认回一段固定结果；用例可用 spy 版本观察入参（与 optimize 注入真实现的做法不同）。 */
function fakeAssist(): AiDeps['assist'] {
  return async () => ({ text: '结果', degraded: false });
}

function makeAi(
  seed: Record<string, unknown> = {},
  adapterOverride?: ProviderAdapter,
  cryptoOverride?: SecretCrypto,
  assistOverride?: AiDeps['assist'],
) {
  const kv = fakeKv(seed);
  const adapter = adapterOverride ?? fakeAdapter();
  const onChanged = vi.fn();
  const onDelta = vi.fn();
  const onDeltaEnd = vi.fn();
  const api = createAi({
    kv,
    adapterFor: () => adapter,
    // ★ 用真的 optimize（含 buildMetaPrompt + parseOptimized），只把网络那层换掉。
    optimize: runOptimize,
    assist: assistOverride ?? fakeAssist(),
    onChanged,
    onDelta,
    onDeltaEnd,
    // ★ 不传 cryptoOverride = 不注入保险箱 = 升级前的明文路径（既有用例全靠这条）。
    ...(cryptoOverride ? { secretBox: createSecretBox(cryptoOverride) } : {}),
  });
  return { api, kv, adapter, onChanged, onDelta, onDeltaEnd };
}

/**
 * 直接种进库的 provider 元数据（绕开 saveProvider）。
 *
 * ★ 为什么要绕开：saveProvider 结尾会 return list()，而 list() 会读 Key —— 走这条种子
 *   迁移在 saveProvider 里就发生了，测不到「第一次读才迁移」。
 */
function providerSeed(): Record<string, unknown> {
  return {
    [PROVIDERS_KEY]: [
      { id: 'p1', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
    ],
  };
}

/** 记录调用次数：用来断言「迁移幂等 = 第二次读不再写库」。 */
function countingKv(seed: Record<string, unknown> = {}) {
  const kv = fakeKv(seed);
  const writes = vi.fn();
  return {
    ...kv,
    writes,
    setSettingValue(key: string, value: unknown): void {
      writes(key, value);
      kv.setSettingValue(key, value);
    },
  } as AiKv & { store: Map<string, unknown>; writes: ReturnType<typeof vi.fn> };
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
      api.optimize({
        providerId: 'missing',
        text: '帮我写个周报',
        sceneId: 'general',
        mode: 'user',
        requestId: 'req-1',
      }),
    ).rejects.toThrow('请先在设置里添加 AI 模型');
    // 没配 provider 时不该广播，也不该假装成功。
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('optimize 把 requestId 与「已可展示」的文本交给 onDelta（spy 适配器，不联网）', async () => {
    const { api, onDelta } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    const res = await api.optimize({
      providerId: 'p1',
      text: '帮我写个周报',
      sceneId: 'general',
      mode: 'user',
      requestId: 'req-42',
    });
    // 整段结果照旧从 invoke 带回（增量只是"边下边看"，不替代返回值）。
    expect(res.optimized).toBe('你是资深编辑，请把这段改清楚。');
    expect(onDelta).toHaveBeenCalled();
    // 每一段增量都带同一个 requestId：渲染层靠它配对，错一个字符整段就被当过期丢弃。
    for (const call of onDelta.mock.calls) expect(call[0]).toBe('req-42');
    // onPreview 给的是成品文本，不是原始流：没有 <optimized> 标签、没有 notes。
    const last = onDelta.mock.calls.at(-1) as [string, string];
    expect(last[1]).toBe('你是资深编辑，请把这段改清楚。');
    expect(last[1]).not.toContain('<optimized>');
    expect(last[1]).not.toContain('<notes>');
  });

  it('requestId 为空时不接 onPreview：不发没有配对键的增量', async () => {
    const { api, onDelta } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    await api.optimize({
      providerId: 'p1',
      text: '帮我写个周报',
      sceneId: 'general',
      mode: 'user',
      requestId: '',
    });
    expect(onDelta).not.toHaveBeenCalled();
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

  it('未注入 secretBox 时行为不变：库里仍是明文 Key（升级前的路径）', async () => {
    const { api, kv } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    expect(kv.getSettingValue(keyKey('p1'))).toBe(FULL_KEY);
    expect((await api.listProviders())[0]!.keyMask).toBe(maskKey(FULL_KEY));
  });
});

describe('ai + keyvault：Key 加密落库与明文迁移（升级项 ①）', () => {
  it('注入 secretBox 后落库是密文，而 optimize/test 用的仍是明文', async () => {
    const seen: string[] = [];
    const adapter = fakeAdapter();
    const spy = {
      ...adapter,
      async chat(_cfg: ProviderConfig, key: string): Promise<string> {
        seen.push(key);
        return '<optimized>你是资深编辑，请把这段改清楚。</optimized>';
      },
      async test(cfg: ProviderConfig, key: string): Promise<{ ok: true; model: string }> {
        seen.push(key);
        return { ok: true, model: 'fake-model' };
      },
    } as unknown as ProviderAdapter;
    const { api, kv } = makeAi({}, spy, fakeCrypto());

    await api.saveProvider(row({ apiKey: FULL_KEY }));
    const stored = kv.getSettingValue(keyKey('p1'));
    expect(typeof stored).toBe('string');
    expect((stored as string).startsWith(ENC_PREFIX)).toBe(true);
    // 落库串里不该出现明文。
    expect(stored as string).not.toContain(FULL_KEY);

    // 对外仍是掩码，与加密无关。
    const p = (await api.listProviders())[0]!;
    expect(p.hasKey).toBe(true);
    expect(p.keyMask).toBe(maskKey(FULL_KEY));

    // 真正发请求的那层拿到的是明文。
    expect(await api.test('p1')).toMatchObject({ ok: true });
    await api.optimize({ providerId: 'p1', text: '帮我写个周报', sceneId: 'general', mode: 'user', requestId: 'req-enc' });
    expect(seen).toContain(FULL_KEY);
  });

  it('★ 存量明文 Key 在首次读取后就地加密，返回值仍是原明文', async () => {
    // 种子模拟升级前的老库：元数据在、aiKey:p1 是裸明文。
    const { api, kv } = makeAi({ ...providerSeed(), [keyKey('p1')]: FULL_KEY }, undefined, fakeCrypto());
    expect(kv.getSettingValue(keyKey('p1'))).toBe(FULL_KEY);

    const list = await api.listProviders();
    // 对外表现不变：hasKey 与掩码都按明文算。
    expect(list[0]!.hasKey).toBe(true);
    expect(list[0]!.keyMask).toBe(maskKey(FULL_KEY));

    const stored = kv.getSettingValue(keyKey('p1')) as string;
    expect(stored.startsWith(ENC_PREFIX)).toBe(true);
    expect(stored).not.toContain(FULL_KEY);
    // 迁移后照样解得回原明文。
    expect(await api.test('p1')).toMatchObject({ ok: true });
  });

  it('迁移幂等：连续两次读，第二次不再写库', async () => {
    const kv = countingKv({ ...providerSeed(), [keyKey('p1')]: FULL_KEY });
    const api = createAi({
      kv,
      adapterFor: () => fakeAdapter(),
      optimize: runOptimize,
      assist: fakeAssist(),
      secretBox: createSecretBox(fakeCrypto()),
    });

    await api.listProviders();
    const afterFirst = kv.getSettingValue(keyKey('p1')) as string;
    expect(afterFirst.startsWith(ENC_PREFIX)).toBe(true);
    expect(kv.writes).toHaveBeenCalledTimes(1);
    expect(kv.writes).toHaveBeenCalledWith(keyKey('p1'), afterFirst);

    kv.writes.mockClear();
    await api.listProviders();
    // ★ 第二次读已经是密文，不该再写一次（否则每次列列表都写库）。
    expect(kv.writes).not.toHaveBeenCalled();
    expect(kv.getSettingValue(keyKey('p1'))).toBe(afterFirst);
  });

  it('加密不可用时降级为 plain:v1:，读回来仍是明文，且不反复写库', async () => {
    const kv = countingKv({ ...providerSeed(), [keyKey('p1')]: FULL_KEY });
    const api = createAi({
      kv,
      adapterFor: () => fakeAdapter(),
      optimize: runOptimize,
      assist: fakeAssist(),
      secretBox: createSecretBox(fakeCrypto({ available: () => false })),
    });

    const list = await api.listProviders();
    expect(list[0]!.hasKey).toBe(true);
    expect(list[0]!.keyMask).toBe(maskKey(FULL_KEY));
    // 降级值形态正确（不假装加密），且首次写入就落地。
    expect(kv.getSettingValue(keyKey('p1'))).toBe('plain:v1:' + FULL_KEY);
    expect(kv.writes).toHaveBeenCalledTimes(1);

    // ★ 再读一次不再写库：否则每次列列表都写一遍。
    kv.writes.mockClear();
    await api.listProviders();
    expect(kv.writes).not.toHaveBeenCalled();
  });

  it('密文解不开时按「没配 Key」处理，不炸整个列表', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 换用户/换机器拷来的库：DPAPI 解不开。
    const { api } = makeAi({ ...providerSeed(), [keyKey('p1')]: ENC_PREFIX + 'Zm9v' }, undefined, {
      ...fakeCrypto(),
      decrypt: () => {
        throw new Error('DPAPI 解密失败');
      },
    });

    const list = await api.listProviders();
    expect(list).toHaveLength(1);
    expect(list[0]!.hasKey).toBe(false);
    expect(list[0]!.keyMask).toBe('••••');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('迁移写回失败不致命：仍然返回明文继续用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kv = fakeKv({ ...providerSeed(), [keyKey('p1')]: FULL_KEY });
    const api = createAi({
      kv,
      adapterFor: () => fakeAdapter(),
      optimize: runOptimize,
      assist: fakeAssist(),
      secretBox: {
        seal: () => {
          throw new Error('加密实现崩了');
        },
        open: (s: string) => s,
      },
    });

    const list = await api.listProviders();
    expect(list[0]!.hasKey).toBe(true);
    expect(list[0]!.keyMask).toBe(maskKey(FULL_KEY));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('ai.cancel：停止在途优化', () => {
  const req = (requestId: string) => ({
    providerId: 'p1',
    text: '帮我写个周报',
    sceneId: 'general',
    mode: 'user' as const,
    requestId,
  });

  it('★ cancel 让在途请求真的中止（不是只把界面上的 loading 关掉）', async () => {
    const { api, onDeltaEnd } = makeAi({}, hangingAdapter());
    await api.saveProvider(row({ apiKey: FULL_KEY }));

    const pending = api.optimize(req('req-stop'));
    // 让 optimize 真正进到 chatStream 挂住的状态，再发取消。
    await new Promise((r) => setTimeout(r, 0));
    await api.cancel('req-stop');

    await expect(pending).rejects.toBeTruthy();
    // 失败也要冲尾包：否则节流器里最后一段永远发不出去。
    expect(onDeltaEnd).toHaveBeenCalledWith('req-stop');
  });

  it('cancel 未知 requestId 静默返回（重复点「停止」不报错）', async () => {
    const { api } = makeAi();
    await expect(api.cancel('从来没有过的 id')).resolves.toBeUndefined();
  });

  it('cancel 空串静默返回，不抛', async () => {
    const { api } = makeAi();
    await expect(api.cancel('')).resolves.toBeUndefined();
  });

  it('请求结束后取消器被清掉：再 cancel 同一个 id 不会误伤后来的请求', async () => {
    const { api } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    await api.optimize(req('req-done'));

    // 请求已结束，表里不该还留着这个 id；cancel 应当是 no-op 而不是抛。
    await expect(api.cancel('req-done')).resolves.toBeUndefined();
  });

  it('已结束的请求被 cancel 不会把结果变成失败（幂等）', async () => {
    const { api } = makeAi();
    await api.saveProvider(row({ apiKey: FULL_KEY }));
    const res = await api.optimize(req('req-ok'));

    await api.cancel('req-ok');

    expect(res.optimized).toBe('你是资深编辑，请把这段改清楚。');
  });
});

describe('ai.assist：剪贴板 AI 助手（v1.0.0 第 ⑤ 项）', () => {
  /** 观察注入函数收到了什么（主进程只做转发，提示词在 @clipchan/ai 里组）。 */
  function spyAssist(result: AssistResult = { text: '结果', degraded: false }) {
    return vi.fn<AiDeps['assist']>(async () => result);
  }

  it('assist 把请求转发给注入的 assist，并透传 text/degraded', async () => {
    const spy = spyAssist({ text: '这是总结。', degraded: true });
    const { api } = makeAi({}, undefined, undefined, spy);
    await api.saveProvider(row({ apiKey: FULL_KEY }));

    const res = await api.assist({ providerId: 'p1', action: 'summarize', text: '一段原文' });

    // degraded 不能吞：界面要靠它提示"模型没按格式来"。
    expect(res).toEqual({ text: '这是总结。', degraded: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const [adapter, cfg, key, input] = spy.mock.calls[0]!;
    expect(adapter).toBeTruthy();
    expect(cfg.id).toBe('p1');
    expect(cfg.protocol).toBe('anthropic');
    expect(key).toBe(FULL_KEY);
    expect(input.action).toBe('summarize');
    expect(input.text).toBe('一段原文');
    // 没传的可选键不该出现（不是 undefined 占位）。
    expect(Object.prototype.hasOwnProperty.call(input, 'targetLang')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(input, 'extra')).toBe(false);
  });

  it('assist 在 action 非法时抛错，不调用注入函数', async () => {
    const spy = spyAssist();
    const { api } = makeAi({}, undefined, undefined, spy);
    await api.saveProvider(row({ apiKey: FULL_KEY }));

    await expect(
      // 界面是白名单，但 IPC 是任意可调的：非法动作必须在这里被拦住。
      api.assist({ providerId: 'p1', action: 'delete-everything' as never, text: '一段原文' }),
    ).rejects.toThrow('不认识的 AI 动作：delete-everything');
    expect(spy).not.toHaveBeenCalled();
  });

  it('assist 在 text 全空白时抛错', async () => {
    const spy = spyAssist();
    const { api } = makeAi({}, undefined, undefined, spy);
    await api.saveProvider(row({ apiKey: FULL_KEY }));

    await expect(api.assist({ providerId: 'p1', action: 'summarize', text: '   \n\t ' })).rejects.toThrow(
      '没有可处理的文本',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('translate 且给了 targetLang 时，注入函数收到 targetLang', async () => {
    const spy = spyAssist({ text: 'Hello.', degraded: false });
    const { api } = makeAi({}, undefined, undefined, spy);
    await api.saveProvider(row({ apiKey: FULL_KEY }));

    await api.assist({ providerId: 'p1', action: 'translate', text: '一段原文', targetLang: 'en' });

    const input = spy.mock.calls[0]![3] as AssistInput;
    expect(input.action).toBe('translate');
    expect(input.targetLang).toBe('en');
  });

  it('summarize 时即使 req 带了 targetLang 也不传下去（只有 translate 需要）', async () => {
    const spy = spyAssist();
    const { api } = makeAi({}, undefined, undefined, spy);
    await api.saveProvider(row({ apiKey: FULL_KEY }));

    await api.assist({ providerId: 'p1', action: 'summarize', text: '一段原文', targetLang: 'en' });

    const input = spy.mock.calls[0]![3] as AssistInput;
    // ★ 传下去的话提示词里会冒出一句"翻译成英文"，把总结写成翻译。
    expect(input.targetLang).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(input, 'targetLang')).toBe(false);
  });

  it('assist 走的是和 optimize 同一套 provider 解析：providerId 不存在时报错', async () => {
    const spy = spyAssist();
    const { api, onChanged } = makeAi({}, undefined, undefined, spy);

    await expect(api.assist({ providerId: 'missing', action: 'summarize', text: '一段原文' })).rejects.toThrow(
      '请先在设置里添加 AI 模型',
    );
    // 没配 provider 时不该广播，也不该假装成功（与 optimize 的既有断言一致）。
    expect(onChanged).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});
