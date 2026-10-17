import type { PasteResult } from '../types';
import { pasteHintOf } from '../logic/paste';

/**
 * 浮层提示（Toast）文案。
 * 覆盖 spec §7.3 的粘贴三种失败原因（Task 6）、§7.5 的拼接三种拒绝理由
 * 与幽灵模式的跳过 / 恢复（Task 5）。粘贴文案与 pasteHintOf 同源，
 * 避免界面与逻辑两处各写一份。
 */

export type ToastTone = 'ok' | 'warn' | 'error';

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
