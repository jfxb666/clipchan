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
