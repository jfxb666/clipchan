import type { ToastTone } from './toastText';

/**
 * 优化面板的纯函数与常量（计划 Task 7 Step 2，并按用户实测反馈扩充）。
 * 仓库无 jsdom / testing-library（§2 约束），组件不可测，
 * 因此面板里所有可测逻辑都放进这个不依赖 React 的模块。
 */

export interface OptimizeMode {
  key: 'user' | 'system';
  label: string;
}

/** 两种优化目标：改写用户的提示词，或产出一份 system 提示词。 */
export const OPTIMIZE_MODES: OptimizeMode[] = [
  { key: 'user', label: '用户提示词' },
  { key: 'system', label: '系统提示词' },
];

/**
 * 模型没按约定格式返回时，引擎会把全文直接采用并置 degraded。
 * 这里给出给用户看的中文提示；正常解析时为 null（不显示黄条）。
 */
export function degradedHint(degraded: boolean): string | null {
  return degraded ? '模型未按格式输出，已直接采用全文' : null;
}

/** 传入的 crypto 面（宿主上就是 globalThis.crypto，测试里可注入）。 */
export interface CryptoLike {
  randomUUID?: () => string;
}

function defaultCrypto(): CryptoLike | null {
  return (globalThis as { crypto?: CryptoLike }).crypto ?? null;
}

/** 本地兜底序号的模块内计数：同一毫秒内连续生成也保证不重复。 */
let fallbackSeq = 0;

/**
 * 生成一次优化请求的 requestId。
 * 优先 `crypto.randomUUID()`；宿主不给（无 crypto / 抛错 / 返回空串）时退回
 * 时间戳 + 递增序号 + 随机串的本地实现——**必须给得出 id**，否则「优化」按钮
 * 会因为没有 requestId 而整个失效（不假装成功，也不静默失灵）。
 */
export function newRequestId(cryptoLike: CryptoLike | null = defaultCrypto()): string {
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    try {
      const id = cryptoLike.randomUUID();
      if (typeof id === 'string' && id !== '') return id;
    } catch {
      // 落到下面的本地实现。
    }
  }
  fallbackSeq += 1;
  return (
    'req-' +
    Date.now().toString(36) +
    '-' +
    fallbackSeq.toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  );
}

/** 一次优化请求的流式预览状态。 */
export interface OptimizeStream {
  /** 在途请求的 requestId；面板只用匹配它的增量。 */
  requestId: string;
  /** 已收到的预览文本。 */
  text: string;
}

/** 一条流式增量（与主进程 ai.onOptimizeDelta 投影的形状一致）。 */
export interface OptimizeDeltaLike {
  requestId: string;
  text: string;
}

/** 点「优化」/「重试」：清空上一次的预览，并把在途请求换成新的 requestId。 */
export function beginStream(requestId: string): OptimizeStream {
  return { requestId, text: '' };
}

/**
 * requestId 形状校验：非空字符串且不含空白字符。
 * 增量是跨进程投影过来的，形状不对（空串 / 缺字段 / 非字符串）就当过期数据丢弃，
 * 既不抛错也不写进预览——否则界面上会混进来源不明的文本。
 */
export function isValidRequestId(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && !/\s/.test(id);
}

/**
 * 流式文本合并规则：只接受在途请求（activeRequestId）的增量，按到达顺序追加；
 * 过期请求的 delta（用户已经重新点了优化）一律丢弃，返回原文本。
 */
export function mergeDelta(prev: string, delta: OptimizeDeltaLike, activeRequestId: string | null): string {
  if (!isValidRequestId(activeRequestId)) return prev;
  if (!isValidRequestId(delta.requestId) || delta.requestId !== activeRequestId) return prev;
  return prev + delta.text;
}

/**
 * 请求收尾：清空在途 requestId。
 * 结束后迟到的增量一律丢弃，不会追加到用户正在编辑的最终文本上。
 */
export function endStream(): null {
  return null;
}

/** 「复制」成功后的固定文案：只写剪贴板，不贴回目标窗口。 */
export const COPIED_TOAST = '已复制到剪贴板';

/** 复制失败的中文提示（默认文案；原因单独拼在冒号后）。 */
export const COPY_FAILED_TOAST = '复制失败，请重试';

export function copiedToast(): { text: string; tone: ToastTone } {
  return { text: COPIED_TOAST, tone: 'ok' };
}

/** 失败原因：Error / 字符串取原文，其它类型不把 undefined 摊给用户。 */
function failureDetail(err: unknown): string {
  if (err instanceof Error) return err.message.trim();
  if (typeof err === 'string') return err.trim();
  return '';
}

export function copyFailedToast(err: unknown): { text: string; tone: ToastTone } {
  const detail = failureDetail(err);
  return { text: detail === '' ? COPY_FAILED_TOAST : COPY_FAILED_TOAST + '：' + detail, tone: 'error' };
}
