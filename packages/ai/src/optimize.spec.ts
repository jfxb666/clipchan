import { describe, expect, it } from 'vitest';
import { buildMetaPrompt } from './meta-prompt';
import { DEFAULT_TIMEOUT_MS, optimize, parseOptimized } from './optimize';
import type { Scene } from './scenes';
import type { ChatMessage, ProviderAdapter, ProviderConfig } from './types';

const SCENE: Scene = {
  id: 'product',
  name: '产品·项目描述',
  description: '写产品介绍、项目说明、需求文档，把形容词换成能验证的事实',
  rules: ['先用一句话给出价值主张', '写清目标用户与痛点', '给出差异化与证据', '结构化分段'],
  example: { input: '我们做了个剪贴板工具', output: '剪贴板酱帮……' },
};

const CFG: ProviderConfig = {
  id: 'p1',
  name: '本地中转',
  protocol: 'openai-compat',
  baseUrl: 'https://example.com/v1',
  model: 'gpt-4o-mini',
};

const TEXT = '我们做了个剪贴板管理工具，挺好用的';

interface ChatCall {
  cfg: ProviderConfig;
  key: string;
  messages: ChatMessage[];
  opts?: { signal?: AbortSignal; timeoutMs?: number };
}

/** 假适配器：不发任何网络请求，只记录 optimize 传下来的入参（计划 Task 4 Step 1「编排走通」）。 */
function stubAdapter(reply: string) {
  const calls: ChatCall[] = [];
  const adapter: ProviderAdapter = {
    chat: async (cfg, key, messages, opts) => {
      calls.push({ cfg, key, messages, opts });
      return reply;
    },
    // 也记录入参并返回同一份 reply：optimize 现在优先走流式，两条路径的断言都要能成立。
    chatStream: async (cfg, key, messages, opts) => {
      calls.push({ cfg, key, messages, opts });
      if (opts?.onDelta) opts.onDelta(reply);
      return reply;
    },
    listModels: async () => {
      throw new Error('stub 不支持 listModels');
    },
    test: async () => {
      throw new Error('stub 不支持 test');
    },
  };
  return { adapter, calls };
}

describe('parseOptimized', () => {
  it('带标签：切出 optimized 与 notes，degraded 为 false', () => {
    expect(parseOptimized('<optimized>A</optimized><notes>- x</notes>')).toEqual({
      optimized: 'A',
      notes: ['- x'],
      degraded: false,
    });
  });

  it('带围栏：整体被 markdown 代码块包裹时剥壳，degraded 仍为 false', () => {
    const parsed = parseOptimized('```\nA\n```');
    expect(parsed.optimized).toBe('A');
    expect(parsed.degraded).toBe(false);
    expect(parsed.optimized).not.toContain('```');
  });

  it('裸文本：degraded 为 true，notes 提示模型未按格式输出（Review Focus 4）', () => {
    const parsed = parseOptimized('A');
    expect(parsed.optimized).toBe('A');
    expect(parsed.degraded).toBe(true);
    expect(parsed.notes).toContain('模型未按格式输出，已直接采用全文');
  });
});

describe('optimize', () => {
  it('编排走通：stub 收到的 messages 来自 buildMetaPrompt，返回值经 parseOptimized', async () => {
    const { adapter, calls } = stubAdapter('<optimized>优化后的提示词</optimized><notes>- 补了输出格式</notes>');
    const result = await optimize(adapter, CFG, 'sk-test-key', { text: TEXT, scene: SCENE, mode: 'user' });

    expect(result).toEqual({ optimized: '优化后的提示词', notes: ['- 补了输出格式'], degraded: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cfg).toBe(CFG);
    expect(calls[0]?.key).toBe('sk-test-key');
    expect(calls[0]?.messages).toEqual(buildMetaPrompt({ text: TEXT, scene: SCENE, mode: 'user' }));
  });

  it('超时默认 60s 且 AbortSignal 透传（Review Focus 3）', async () => {
    const { adapter, calls } = stubAdapter('<optimized>A</optimized>');
    const signal = new AbortController().signal;

    await optimize(adapter, CFG, 'k', { text: TEXT, scene: SCENE, mode: 'user' });
    expect(calls[0]?.opts?.timeoutMs).toBe(60000);
    expect(calls[0]?.opts?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);

    await optimize(adapter, CFG, 'k', { text: TEXT, scene: SCENE, mode: 'system', signal, timeoutMs: 1234 });
    expect(calls[1]?.opts?.timeoutMs).toBe(1234);
    expect(calls[1]?.opts?.signal).toBe(signal);
  });
});
