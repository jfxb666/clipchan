import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, toAiError } from './types';

const CTX = { timeoutMs: 60000 };

describe('normalizeBaseUrl', () => {
  it('openai-compat 缺少版本段时补 /v1', () => {
    expect(normalizeBaseUrl('openai-compat', 'https://x.com')).toBe('https://x.com/v1');
  });

  it('去尾斜杠', () => {
    expect(normalizeBaseUrl('openai-compat', 'https://x.com/v1/')).toBe('https://x.com/v1');
  });

  it('已有版本段不重复补', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1',
    );
  });

  it('gemini 补 /v1beta', () => {
    expect(normalizeBaseUrl('gemini', 'https://generativelanguage.googleapis.com')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
  });

  it('非法 URL 抛错', () => {
    expect(() => normalizeBaseUrl('openai-compat', 'x.com')).toThrow(/Base URL/);
  });
});

describe('toAiError', () => {
  it('401 翻译成 auth', () => {
    expect(toAiError({ status: 401 }, CTX).kind).toBe('auth');
  });

  it('429 翻译成 rate-limit', () => {
    expect(toAiError({ status: 429 }, CTX).kind).toBe('rate-limit');
  });

  it('超时翻译成 timeout', () => {
    expect(toAiError(new DOMException('aborted', 'TimeoutError'), CTX).kind).toBe('timeout');
  });

  it('fetch 网络失败翻译成 network（DNS 不通等，Task 8 GUI 验收踩到）', () => {
    const err = toAiError(new TypeError('fetch failed'), CTX);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('网络');
  });

  it('未知异常不裸抛', () => {
    const err = toAiError(new Error('boom'), CTX);
    expect(err.kind).toBe('unknown');
    expect(err.message).toContain('boom');
  });
});
