import { describe, expect, it } from 'vitest';
import { copyToast, pasteToast } from './toastText';

/**
 * 「复制」与「粘贴」是两条不同的动作，文案也必须不同：
 * 复制成功不能提示「按 Ctrl+V 粘贴」（用户要的就是复制本身）。
 */
describe('copyToast', () => {
  it('成功时只说已复制，不提 Ctrl+V', () => {
    const { text, tone } = copyToast({ ok: true });

    expect(text).toBe('已复制到剪贴板');
    expect(text).not.toContain('Ctrl+V');
    expect(tone).toBe('ok');
  });

  it('失败时如实说复制失败', () => {
    const { text, tone } = copyToast({ ok: false, reason: 'no-target' });

    expect(text).toContain('复制失败');
    expect(tone).toBe('warn');
  });

  it('与粘贴文案不同源：同一条 no-target 结果文案不同', () => {
    const copied = copyToast({ ok: false, reason: 'no-target' });
    const pasted = pasteToast({ ok: false, reason: 'no-target' });

    expect(copied.text).not.toBe(pasted.text);
    expect(pasted.text).toContain('Ctrl+V');
  });
});
