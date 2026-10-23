/**
 * ★ 重点：崩溃兜底的纯逻辑。组件层（ErrorBoundary.tsx）只负责摆放，取值与兜底都在这里。
 * 为什么单独一个文件：仓库的 vitest 只跑 node 环境、没有 jsdom（见 trashViewLogic.spec.ts 文件头），
 * class 组件本身渲染不了；把"从任意抛出物里安全地抠出可读文字"剥出来，才测得到。
 * 本文件不 import react，也不读任何全局（时间与 userAgent 都由调用方注入）。
 */

/** title 上限：兜底页一行放得下，再长就是噪声。 */
const TITLE_MAX = 200;
/** detail 上限：整份堆栈塞进 <pre> 会让兜底页卡死，4000 字符够定位。 */
const DETAIL_MAX = 4000;
const UNKNOWN = '未知错误';

/** 按上限截断；超长时用省略号占掉最后一格，保证返回值长度不超过 max。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** 取值过程本身可能抛（getter 抛、Proxy trap 抛），任何一次都要回落到 fallback。 */
function readOr<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 错误对象上我们要的三个字段，全部按 unknown 处理——它们的 getter 随时可能抛。 */
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

/**
 * 为什么不能只认 instanceof Error：跨 realm（iframe / worker / vm）抛出的错误、
 * 被库包装成 { message, stack } 的对象都不满足 instanceof，只认它就会退化成
 * '[object Object]'，用户复制出来的报告等于没有。所以带 message 或 stack 的对象也当错误看待。
 */
function asErrorLike(e: unknown): ErrorLike | null {
  if (typeof e !== 'object' || e === null) return null;
  if (e instanceof Error) return e;
  try {
    if ('message' in e || 'stack' in e) return e;
  } catch {
    return null;
  }
  return null;
}

/** 把任意抛出物变成「标题 + 细节」。任何一步抛错都回落到「未知错误」。 */
export function describeError(e: unknown): { title: string; detail: string } {
  try {
    const like = asErrorLike(e);
    if (like) {
      const name = textOf(readOr(() => like.name, undefined));
      const message = textOf(readOr(() => like.message, undefined));
      const head = name && message ? name + ': ' + message : name || message;
      const detail = textOf(readOr(() => like.stack, undefined));
      // 连 name/message 都读不出来（比如 getter 直接抛）时，别给用户看空标题。
      return { title: clip(head || UNKNOWN, TITLE_MAX), detail: clip(detail, DETAIL_MAX) };
    }
    // null / undefined 说明错误在某一层被吞掉了，显示 'null' 只会让人更糊涂。
    if (e === null || e === undefined) return { title: UNKNOWN, detail: '' };
    return { title: clip(readOr(() => String(e), UNKNOWN), TITLE_MAX), detail: '' };
  } catch {
    return { title: UNKNOWN, detail: '' };
  }
}

/** 报告里用到的环境信息，由调用方注入：本文件保持纯函数，单测才能给定值。 */
export interface CrashReportContext {
  /** navigator.userAgent；不传就不写这一行（node 环境里没有 navigator）。 */
  userAgent?: string;
  /** 注入时钟，单测才能断言 ISO 时间。 */
  at?: Date;
}

/**
 * 生成一段用户能直接复制发过来的崩溃报告。
 * 纯字符串拼接：崩溃现场读全局随时可能二次抛错，所以 userAgent 与时间都从参数来。
 */
export function crashReportText(
  e: unknown,
  appVersion: string,
  context: CrashReportContext = {},
): string {
  const { title, detail } = describeError(e);
  const at = context.at ?? new Date();
  const iso = readOr(() => at.toISOString(), '');
  const lines = ['剪贴板酱 v' + appVersion + ' 界面出错'];
  if (iso) lines.push('时间：' + iso);
  if (context.userAgent) lines.push('环境：' + context.userAgent);
  lines.push('错误：' + title);
  if (detail) lines.push('', detail);
  return lines.join('\n');
}
