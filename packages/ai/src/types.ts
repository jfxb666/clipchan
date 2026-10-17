/** 支持的三种协议。 */
export type AiProtocol = 'openai-compat' | 'anthropic' | 'gemini';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** provider 元数据；**不含 apiKey**，Key 单独由主进程保管。 */
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
}

export interface AiError {
  kind: 'auth' | 'network' | 'timeout' | 'rate-limit' | 'bad-response' | 'unknown';
  status?: number;
  message: string;
}

export type ChatOptions = { signal?: AbortSignal; timeoutMs?: number };

export interface ProviderAdapter {
  chat(cfg: ProviderConfig, key: string, messages: ChatMessage[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
  listModels(cfg: ProviderConfig, key: string): Promise<string[]>;
  test(cfg: ProviderConfig, key: string): Promise<{ ok: true; model: string } | { ok: false; error: AiError }>;
}

/** 各协议缺省版本段。 */
const DEFAULT_VERSION_PATH: Record<AiProtocol, string> = {
  'openai-compat': '/v1',
  anthropic: '/v1',
  gemini: '/v1beta',
};

const VERSION_SEGMENT = /\/v\d/;

/**
 * 去掉末尾斜杠；缺省补协议默认路径（Review Focus 1）。
 * 非法 URL 或非 http(s) 协议直接抛错（中文），不返回半成品。
 */
export function normalizeBaseUrl(protocol: AiProtocol, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Base URL 格式不正确：${raw}（需要形如 https://host 的完整地址）`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Base URL 只支持 http/https：${raw}`);
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!VERSION_SEGMENT.test(path)) {
    path += DEFAULT_VERSION_PATH[protocol];
  }
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

const AI_ERROR_KINDS = ['auth', 'network', 'timeout', 'rate-limit', 'bad-response', 'unknown'] as const;

const KIND_MESSAGE: Record<AiError['kind'], string> = {
  auth: '鉴权失败，请检查 API Key',
  'rate-limit': '请求过于频繁，请稍后再试',
  timeout: '请求超时',
  network: '网络连接失败',
  'bad-response': '模型返回格式异常',
  unknown: '未知错误',
};

/** 是否已经是结构化错误（toAiError 幂等）。 */
export function isAiError(e: unknown): e is AiError {
  if (typeof e !== 'object' || e === null) return false;
  const v = e as { kind?: unknown; message?: unknown };
  return typeof v.message === 'string' && AI_ERROR_KINDS.includes(v.kind as AiError['kind']);
}

function isTimeoutLike(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function kindFromStatus(status: number): AiError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500 && status <= 599) return 'network';
  return 'unknown';
}

/** 把任意异常翻译成 AiError，绝不裸抛（约束：错误路径结构化）。 */
export function toAiError(e: unknown, ctx: { timeoutMs: number }): AiError {
  if (isAiError(e)) return e;

  const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  if (typeof status === 'number') {
    const kind = kindFromStatus(status);
    return { kind, status, message: `${KIND_MESSAGE[kind]}（HTTP ${status}）` };
  }

  if (isTimeoutLike(e)) {
    return { kind: 'timeout', message: `${KIND_MESSAGE.timeout}（${Math.round(ctx.timeoutMs / 1000)} 秒）` };
  }

  // fetch 在 DNS 解析失败 / 连接被拒时统一抛 TypeError("fetch failed")（undici 包装），
  // 归为 network 而不是 unknown，UI 才能显示中文提示（Task 8 GUI 验收踩到）。
  if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TypeError') {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && /fetch failed|failed to fetch/i.test(msg)) {
      return { kind: 'network', message: KIND_MESSAGE.network };
    }
  }

  const message = e instanceof Error ? e.message : String(e);
  return { kind: 'unknown', message: message || KIND_MESSAGE.unknown };
}
