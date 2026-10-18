import {
  type ChatMessage,
  type ChatOptions,
  type ChatStreamOptions,
  type ProviderAdapter,
  type ProviderConfig,
  normalizeBaseUrl,
  toAiError,
} from '../types';
import { DEFAULT_TIMEOUT_MS, pickIdList, pickString, requestJson, requestStream, structured } from './request';

function base(cfg: ProviderConfig): string {
  return normalizeBaseUrl(cfg.protocol, cfg.baseUrl);
}

function authHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

function chat(cfg: ProviderConfig, key: string, messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
  return requestJson(`${base(cfg)}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(key),
    body: { model: cfg.model, messages },
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }).then((json) => {
    const content = pickString(json, ['choices', 0, 'message', 'content']);
    if (content === undefined) {
      throw structured('bad-response', '模型返回里没有 choices[0].message.content');
    }
    return content;
  });
}

/** OpenAI 兼容协议流式：SSE 的 choices[0].delta.content 逐段累加。 */
function chatStream(
  cfg: ProviderConfig,
  key: string,
  messages: ChatMessage[],
  opts?: ChatStreamOptions,
): Promise<string> {
  return requestStream(`${base(cfg)}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(key),
    body: { model: cfg.model, messages, stream: true },
    signal: opts?.signal,
    firstChunkTimeoutMs: opts?.firstChunkTimeoutMs,
    idleTimeoutMs: opts?.idleTimeoutMs,
    onDelta: opts?.onDelta,
    extract: (payload) => pickString(payload, ['choices', 0, 'delta', 'content']),
    extractWhole: (payload) => pickString(payload, ['choices', 0, 'message', 'content']),
  });
}

/** OpenAI 兼容协议（官方 / 各类中转站）。 */
export const openaiCompatAdapter: ProviderAdapter = {
  chat,
  chatStream,

  async listModels(cfg: ProviderConfig, key: string): Promise<string[]> {
    const json = await requestJson(`${base(cfg)}/models`, {
      method: 'GET',
      headers: authHeaders(key),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    // 部分中转站不返回 data[]：降级为空数组，交给 UI 手输模型名（Review Focus 2）
    return pickIdList(json, 'id', 'data');
  },

  async test(cfg: ProviderConfig, key: string) {
    try {
      await chat(cfg, key, [{ role: 'user', content: 'ping' }], { timeoutMs: DEFAULT_TIMEOUT_MS });
      return { ok: true as const, model: cfg.model };
    } catch (e) {
      return { ok: false as const, error: toAiError(e, { timeoutMs: DEFAULT_TIMEOUT_MS }) };
    }
  },
};