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

const ANTHROPIC_VERSION = '2023-06-01';

function base(cfg: ProviderConfig): string {
  return normalizeBaseUrl(cfg.protocol, cfg.baseUrl);
}

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

/** system 消息提到顶层 system 字段，其余进 messages。 */
function chat(cfg: ProviderConfig, key: string, messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');

  return requestJson(`${base(cfg)}/messages`, {
    method: 'POST',
    headers: headers(key),
    body: {
      model: cfg.model,
      max_tokens: 2048,
      ...(system.length > 0 ? { system } : {}),
      messages: rest,
    },
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }).then((json) => {
    const text = pickString(json, ['content', 0, 'text']);
    if (text === undefined) {
      throw structured('bad-response', '模型返回里没有 content[0].text');
    }
    return text;
  });
}

/** Anthropic 原生协议流式：SSE 的 content_block_delta.delta.text 逐段累加。 */
function chatStream(
  cfg: ProviderConfig,
  key: string,
  messages: ChatMessage[],
  opts?: ChatStreamOptions,
): Promise<string> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');

  return requestStream(`${base(cfg)}/messages`, {
    method: 'POST',
    headers: headers(key),
    body: {
      model: cfg.model,
      max_tokens: 2048,
      ...(system.length > 0 ? { system } : {}),
      messages: rest,
      stream: true,
    },
    signal: opts?.signal,
    firstChunkTimeoutMs: opts?.firstChunkTimeoutMs,
    idleTimeoutMs: opts?.idleTimeoutMs,
    onDelta: opts?.onDelta,
    extract: (payload) => pickString(payload, ['delta', 'text']),
    extractWhole: (payload) => pickString(payload, ['content', 0, 'text']),
  });
}

/** Anthropic 原生协议。 */
export const anthropicAdapter: ProviderAdapter = {
  chat,
  chatStream,

  async listModels(cfg: ProviderConfig, key: string): Promise<string[]> {
    const json = await requestJson(`${base(cfg)}/models`, {
      method: 'GET',
      headers: headers(key),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
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