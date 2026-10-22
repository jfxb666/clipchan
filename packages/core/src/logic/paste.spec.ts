import { describe, expect, it } from 'vitest';
import { mapHelperCode, pasteHintOf } from './paste';

describe('mapHelperCode', () => {
  it('0 → ok', () => {
    expect(mapHelperCode(0)).toEqual({ ok: true });
  });

  it('1 与 3 → no-target（窗口失效 / 无输入落点）', () => {
    expect(mapHelperCode(1)).toEqual({ ok: false, reason: 'no-target' });
    expect(mapHelperCode(3)).toEqual({ ok: false, reason: 'no-target' });
  });

  it('6 → elevated', () => {
    expect(mapHelperCode(6)).toEqual({ ok: false, reason: 'elevated' });
  });

  it('2/4/5/7 与未知码 → send-failed', () => {
    for (const c of [2, 4, 5, 7, 99, -1]) {
      expect(mapHelperCode(c)).toEqual({ ok: false, reason: 'send-failed' });
    }
  });
});

describe('pasteHintOf', () => {
  it('三种失败原因是三条不同文案', () => {
    const a = pasteHintOf({ ok: false, reason: 'no-target' });
    const b = pasteHintOf({ ok: false, reason: 'elevated' });
    const c = pasteHintOf({ ok: false, reason: 'send-failed' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('成功文案', () => {
    expect(pasteHintOf({ ok: true })).toBe('已粘贴');
  });

  it('missing（记录内容已丢失）不能提示成"按 Ctrl+V"', () => {
    const hint = pasteHintOf({ ok: false, reason: 'missing' });
    expect(hint).not.toContain('Ctrl+V');
    expect(hint).toContain('丢失');
  });
});
