import { describe, expect, it } from 'vitest';
import { UNDO_LABEL, appToastTone, copyToast, pasteToast, removeToast, undoToast } from './toastText';

/**
 * 主进程的 toast kind 只有 info/warn/error，界面只有 ok/warn/error 三档颜色。
 * info 必须落到 ok：它是"说一声"（导入汇总这类中性信息），
 * 映射成 warn 会让人以为出了岔子。
 */
describe('appToastTone', () => {
  it('info 落到 ok（中性信息不吓人）', () => {
    expect(appToastTone('info')).toBe('ok');
  });

  it('warn / error 原样透传', () => {
    expect(appToastTone('warn')).toBe('warn');
    expect(appToastTone('error')).toBe('error');
  });
});

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
/**
 * 撤销文案。
 *
 * ★ 关键约束：restore 失败的唯一常见原因是 duplicate（同内容已在活跃列表里），
 *   这时用户点了撤销、看到的却是「恢复失败」会以为功能坏了 —— 所以「部分失败」
 *   必须单独成句，说清恢复了几条、几条本来就在。
 */
describe('removeToast', () => {
  it('删除后说明进了回收站（用户要知道还能反悔）', () => {
    const { text, tone } = removeToast(3);

    expect(text).toBe('已删除 3 条（进回收站）');
    expect(tone).toBe('ok');
  });

  it('单条也用同一句式，不搞特殊', () => {
    expect(removeToast(1).text).toBe('已删除 1 条（进回收站）');
  });

  it('撤销按钮文案固定为「撤销」', () => {
    expect(UNDO_LABEL).toBe('撤销');
  });
});

describe('undoToast', () => {
  it('全部恢复成功时只报条数', () => {
    expect(undoToast(2, 0)).toEqual({ text: '已恢复 2 条', tone: 'ok' });
  });

  it('一条都没恢复（全 duplicate）时如实说原因，不假装成功', () => {
    const { text, tone } = undoToast(0, 2);

    expect(text).toBe('未恢复：同内容已在列表中');
    expect(tone).toBe('warn');
  });

  it('部分失败时同时给出恢复数与失败数', () => {
    const { text, tone } = undoToast(2, 1);

    expect(text).toBe('已恢复 2 条，1 条同内容已在列表中');
    expect(tone).toBe('warn');
  });

  it('恢复 0 条且无失败（撤销窗口已过期）时明确说没有可撤销的删除', () => {
    expect(undoToast(0, 0)).toEqual({ text: '没有可撤销的删除', tone: 'warn' });
  });

  it('部分失败的文案里同时出现两个数字，顺序是「已恢复」在前', () => {
    const { text } = undoToast(3, 4);

    expect(text.indexOf('3')).toBeLessThan(text.indexOf('4'));
    expect(text).toContain('已恢复');
  });
});
