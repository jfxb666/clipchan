import {
  type ChatMessage,
  type ChatOptions,
  type ChatStreamOptions,
  type ProviderAdapter,
  type ProviderConfig,
  normalizeBaseUrl,
  toAiError,
} from '../types';
import { DEFAULT_TIMEOUT_MS, pickString, requestJson, requestStream, structured } from './request';

function base(cfg: ProviderConfig): string {
  return normalizeBaseUrl(cfg.protocol, cfg.baseUrl);
}

function withKey(url: string, key: string): string {
  return `${url}?key=${encodeURIComponent(key)}`;
}

interface GeminiPart {
  text: string;
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function toContents(messages: ChatMessage[]): GeminiContent[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
}

function toSystemInstruction(messages: ChatMessage[]): { parts: GeminiPart[] } | undefined {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  return system.length > 0 ? { parts: [{ text: system }] } : undefined;
}

/** 模型列表项：name 形如 `models/gemini-2.0-flash`，剥掉前缀。 */
function stripModelsPrefix(name: string): string {
  return name.replace(/^models\//, '');
}

function chat(cfg: ProviderConfig, key: string, messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
  const systemInstruction = toSystemInstruction(messages);
  return requestJson(withKey(`${base(cfg)}/models/${encodeURIComponent(cfg.model)}:generateContent`, key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      contents: toContents(messages),
      ...(systemInstruction ? { systemInstruction } : {}),
    },
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }).then((json) => {
    const text = pickString(json, ['candidates', 0, 'content', 'parts', 0, 'text']);
    if (text === undefined) {
      throw structured('bad-response', '模型返回里没有 candidates[0].content.parts[0].text');
    }
    return text;
  });
}

/** Gemini 原生协议流式：SSE 的 candidates[0].content.parts[].text 逐段累加。 */
function chatStream(
  cfg: ProviderConfig,
  key: string,
  messages: ChatMessage[],
  opts?: ChatStreamOptions,
): Promise<string> {
  const systemInstruction = toSystemInstruction(messages);
  return requestStream(
    withKey(`${base(cfg)}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`, key),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        contents: toContents(messages),
        ...(systemInstruction ? { systemInstruction } : {}),
      },
      signal: opts?.signal,
      firstChunkTimeoutMs: opts?.firstChunkTimeoutMs,
      idleTimeoutMs: opts?.idleTimeoutMs,
      onDelta: opts?.onDelta,
      extract: (payload) => pickString(payload, ['candidates', 0, 'content', 'parts', 0, 'text']),
      extractWhole: (payload) => pickString(payload, ['candidates', 0, 'content', 'parts', 0, 'text']),
    },
  );
}

/** Gemini 原生协议：key 走查询参数，模型名跟在路径里。 */
export const geminiAdapter: ProviderAdapter = {
  chat,
  chatStream,

  async listModels(cfg: ProviderConfig, key: string): Promise<string[]> {
    const json = await requestJson(withKey(`${base(cfg)}/models`, key), {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (typeof json !== 'object' || json === null) return [];
    const list = (json as { models?: unknown }).models;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const item of list) {
      if (typeof item === 'object' && item !== null) {
        const name = (item as { name?: unknown }).name;
        if (typeof name === 'string' && name.length > 0) out.push(stripModelsPrefix(name));
      }
    }
    return out;
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