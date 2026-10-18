import { type AiError, toAiError } from '../types';

export const DEFAULT_TIMEOUT_MS = 60000;

export interface JsonRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** 缺省 60s（Review Focus 3）。 */
  timeoutMs?: number;
}

/** 造一个结构化错误，别裸抛 Error。 */
export function structured(kind: AiError['kind'], message: string, status?: number): AiError {
  return status === undefined ? { kind, message } : { kind, status, message };
}

/** 超时信号 + 调用方信号合并（Node 20+ 的 AbortSignal.any）。 */
function combinedSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, external]) : timeout;
}

/**
 * 发 JSON 请求并解析；任何失败都以 AiError 形式抛出（401/403→auth、429→rate-limit、
 * 5xx→network、JSON 解析失败→bad-response），绝不把底层异常裸抛给调用方。
 */
export async function requestJson(url: string, req: JsonRequest): Promise<unknown> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = combinedSignal(timeoutMs, req.signal);

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal,
    });
  } catch (e) {
    throw toAiError(e, { timeoutMs });
  }

  if (!res.ok) {
    throw toAiError({ status: res.status }, { timeoutMs });
  }

  try {
    return (await res.json()) as unknown;
  } catch {
    // ★ 响应头已到、体还没读完就中止（默认 60s 兜底最常见）：res.json() 抛的是
    //   "读流被掐断"，不是超时本体。必须先看 signal 再定性，否则真实模型超时
    //   会被误报成 bad-response（Task 8 真实 DeepSeek 端到端实测踩到）。
    if (signal.aborted) {
      const timeoutLike = new Error('请求超时');
      timeoutLike.name = 'TimeoutError';
      throw toAiError(timeoutLike, { timeoutMs });
    }
    throw structured('bad-response', `响应不是合法 JSON（HTTP ${res.status}）`, res.status);
  }
}

/** 从任意响应体里安全取一个字符串字段路径，取不到返回 undefined。 */
export function pickString(value: unknown, path: (string | number)[]): string | undefined {
  let cur: unknown = value;
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object' || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** 从 `data[].id` 或 `models[].name` 这类列表里取 id 数组；响应结构不对时返回 []（Review Focus 2 降级）。 */
export function pickIdList(value: unknown, field: string, key: string): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === 'object' && item !== null) {
      const raw = (item as Record<string, unknown>)[field];
      if (typeof raw === 'string' && raw.length > 0) out.push(raw);
    }
  }
  return out;
}
/** 首块等待上限：连不上/模型不吐字时尽快失败，而不是等到整段超时。 */
export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 30000;
/** 相邻数据块的间隔上限：模型卡住时按 timeout 报错。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60000;

export interface StreamRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  firstChunkTimeoutMs?: number;
  idleTimeoutMs?: number;
  onDelta?: (delta: string) => void;
  /** 从一条 SSE data 负载里取增量文本；undefined 表示这条不是文本增量。 */
  extract: (payload: unknown) => string | undefined;
  /** 端点忽略 stream、回整段 JSON 时的降级提取。 */
  extractWhole: (payload: unknown) => string | undefined;
}

/** 造一个 timeout 形状的 AiError（与 toAiError 的 timeout 分支同义）。 */
function streamTimeout(ms: number): AiError {
  const e = new Error('请求超时');
  (e as { name?: string }).name = 'TimeoutError';
  return toAiError(e, { timeoutMs: ms });
}

/**
 * 发一个 SSE 请求并累加增量文本。
 *
 * 双超时（计划 Review Focus 3 的流式版）：首块 firstChunkTimeoutMs、块间 idleTimeoutMs，
 * 任一触发都归为 kind='timeout'，绝不裸抛。端点不回 SSE 时按整段 JSON 降级（一次 delta）。
 */
export async function requestStream(url: string, req: StreamRequest): Promise<string> {
  const first = req.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
  const idle = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let limit = first;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), limit);
  };
  if (req.signal) {
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  arm();

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
  } catch (e) {
    if (timer !== null) clearTimeout(timer);
    if (controller.signal.aborted && !(req.signal && req.signal.aborted)) throw streamTimeout(limit);
    throw toAiError(e, { timeoutMs: limit });
  }

  if (!res.ok) {
    if (timer !== null) clearTimeout(timer);
    throw toAiError({ status: res.status }, { timeoutMs: limit });
  }

  const ctype = res.headers.get('content-type') ?? '';
  const body = res.body;
  // 降级：不是 SSE（有的中转站/协议直接回整段 JSON）
  if (!body || ctype.indexOf('text/event-stream') === -1) {
    if (timer !== null) clearTimeout(timer);
    try {
      const whole = (await res.json()) as unknown;
      const text = req.extractWhole(whole);
      if (text === undefined) throw structured('bad-response', '模型返回里没有可用文本');
      if (req.onDelta) req.onDelta(text);
      return text;
    } catch (e) {
      if (isAiErrorLike(e)) throw e;
      throw structured('bad-response', '响应既不是 SSE 也不是合法 JSON');
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let sawChunk = false;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      if (!sawChunk) {
        sawChunk = true;
        limit = idle;
      }
      arm();
      buffer += decoder.decode(step.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0 || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload) as unknown;
        } catch {
          continue;
        }
        const delta = req.extract(parsed);
        if (delta === undefined || delta.length === 0) continue;
        accumulated += delta;
        if (req.onDelta) req.onDelta(delta);
      }
    }
  } catch (e) {
    if (controller.signal.aborted && !(req.signal && req.signal.aborted)) throw streamTimeout(limit);
    throw toAiError(e, { timeoutMs: limit });
  } finally {
    if (timer !== null) clearTimeout(timer);
    reader.releaseLock();
  }
  return accumulated;
}

/** 判断是不是已经结构化过的 AiError（避免二次包装）。 */
function isAiErrorLike(e: unknown): e is AiError {
  if (typeof e !== 'object' || e === null) return false;
  const v = e as { kind?: unknown; message?: unknown };
  return typeof v.message === 'string' && typeof v.kind === 'string';
}