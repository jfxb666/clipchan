import type { PasteResult } from '../types';
import { pasteHintOf } from '../logic/paste';

/**
 * 浮层提示（Toast）文案。
 * 覆盖 spec §7.3 的粘贴三种失败原因（Task 6）、§7.5 的拼接三种拒绝理由
 * 与幽灵模式的跳过 / 恢复（Task 5）。粘贴文案与 pasteHintOf 同源，
 * 避免界面与逻辑两处各写一份。
 */

export type ToastTone = 'ok' | 'warn' | 'error';

/**
 * 浮层提示上的可点动作（目前只有「撤销」：删除后 3 秒内可反悔）。
 * 放在这个纯文本模块里，是为了让 store 与 Toast.tsx 都只依赖它、不互相依赖。
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * 主进程的 toast kind → 界面色调。
 * info 落到 ok：主进程用 info 表示"说一声"（导入汇总这类中性信息），
 * 而界面只有三档颜色，没有第四种"中性"可给 —— 硬要 warn/error 会让人以为出错。
 */
export function appToastTone(kind: 'info' | 'warn' | 'error'): ToastTone {
  return kind === 'info' ? 'ok' : kind;
}

/** 幽灵模式期间复制的内容不会被记录，结束后也不补录（spec §6.8 ★）。 */
export const GHOST_SKIP_TOAST = '幽灵模式中，本次复制没有记录（结束后也不会补录）';
/** 幽灵模式关闭、轮询恢复。 */
export const GHOST_RESUME_TOAST = '监听已恢复，之后的复制会正常记录';

/** 开启幽灵模式时的提示，带用户选的时长。 */
export function ghostOnToast(minutes: number): string {
  return '幽灵模式已开启，接下来 ' + minutes + ' 分钟内不记录剪贴板';
}

/** 粘贴结果 → 提示文案与色调（三种失败原因是三条不同文案）。 */
export function pasteToast(result: PasteResult): { text: string; tone: ToastTone } {
  return { text: pasteHintOf(result), tone: result.ok ? 'ok' : 'warn' };
}

/** 「只复制」的文案：与粘贴区分开，不提示 Ctrl+V（用户要的是复制本身）。 */
export function copyToast(result: PasteResult): { text: string; tone: ToastTone } {
  return result.ok
    ? { text: '已复制到剪贴板', tone: 'ok' }
    : { text: '复制失败，请重试', tone: 'warn' };
}

/** 拼接结果 → 提示文案。count 为选中条数，skippedImages 为被跳过的图片条数。 */
export function mergeToast(
  result: { ok: boolean; id?: string; reason?: string },
  count: number,
  skippedImages = 0,
): { text: string; tone: ToastTone } {
  if (result.ok) {
    const base = '已把 ' + count + ' 条拼接为 1 条';
    return {
      text: skippedImages > 0 ? base + '（已跳过 ' + skippedImages + ' 条图片）' : base,
      tone: 'ok',
    };
  }
  const map: Record<string, string> = {
    'not-enough': '拼接需要至少 2 条，按住 Ctrl 或 Shift 多选几条再按 Ctrl+M',
    pinned: '拼接需要至少 2 条未收藏记录，收藏项不会被合并',
    'images-skipped': '图片不参与拼接，已跳过 ' + skippedImages + ' 条',
  };
  const reason = result.reason ?? '';
  return { text: map[reason] ?? '拼接失败，请重试', tone: 'warn' };
}
/** 「撤销」按钮的文案（删除后 3 秒窗口内出现）。 */
export const UNDO_LABEL = '撤销';

/** 删除后的提示文案：条数 + 3 秒内可撤销的提示。 */
export function removeToast(count: number): { text: string; tone: ToastTone } {
  return { text: '已删除 ' + count + ' 条（进回收站）', tone: 'ok' };
}

/**
 * 撤销结果 → 提示文案。
 *
 * ★ 为什么要把「部分失败」单独成句：restore 失败的唯一常见原因是 duplicate
 *   （同内容已在活跃列表里，唯一索引挡住 UPDATE）。这时用户点了撤销、看到的
 *   却是"恢复失败"会以为功能坏了；如实说"恢复了 2 条、1 条本来就在列表里"才对得上事实。
 */
export function undoToast(restored: number, failed: number): { text: string; tone: ToastTone } {
  if (failed === 0) {
    return restored > 0
      ? { text: '已恢复 ' + restored + ' 条', tone: 'ok' }
      : { text: '没有可撤销的删除', tone: 'warn' };
  }
  if (restored === 0) {
    return { text: '未恢复：同内容已在列表中', tone: 'warn' };
  }
  return { text: '已恢复 ' + restored + ' 条，' + failed + ' 条同内容已在列表中', tone: 'warn' };
}
