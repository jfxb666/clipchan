import type { PasteResult } from '../types';

/**
 * 助手进程的结果码 → 界面能用的 PasteResult。
 * 码表见设计文档 §7.2：0 成功 / 1 窗口失效 / 2 归位失败 / 3 无输入落点 /
 * 4 SendInput 部分投递 / 5 参数错误 / 6 目标提权 / 7 归位后仍无落点。
 */
export function mapHelperCode(code: number): PasteResult {
  switch (code) {
    case 0: return { ok: true };
    case 1: return { ok: false, reason: 'no-target' };
    case 2: return { ok: false, reason: 'send-failed' };
    case 3: return { ok: false, reason: 'no-target' };
    case 4: return { ok: false, reason: 'send-failed' };
    case 5: return { ok: false, reason: 'send-failed' };
    case 6: return { ok: false, reason: 'elevated' };
    case 7: return { ok: false, reason: 'send-failed' };
    default: return { ok: false, reason: 'send-failed' };
  }
}

/** 粘贴失败时给用户看的中文提示。三种原因必须是三条不同文案。 */
export function pasteHintOf(result: PasteResult): string {
  if (result.ok) return '已粘贴';
  switch (result.reason) {
    case 'no-target': return '已复制，按 Ctrl+V 粘贴';
    case 'elevated': return '目标窗口以管理员运行，无法自动粘贴（已复制）';
    default: return '已复制，但自动粘贴失败，请按 Ctrl+V';
  }
}
