import { describe, expect, it } from 'vitest';
import type { PasteResult } from '../types';
import {
  GHOST_RESUME_TOAST,
  GHOST_SKIP_TOAST,
  ghostOnToast,
  mergeToast,
  pasteToast,
} from './toastText';

/** 浮层提示文案单测：粘贴三种失败原因、拼接三种拒绝理由、幽灵模式两句。 */

describe('pasteToast 文案与色调', () => {
  it('成功是 ok 色调，文案「已粘贴」', () => {
    expect(pasteToast({ ok: true })).toEqual({ text: '已粘贴', tone: 'ok' });
  });

  it('三种失败原因各给不同文案，且都是 warn 色调', () => {
    const results: PasteResult[] = [
      { ok: false, reason: 'no-target' },
      { ok: false, reason: 'elevated' },
      { ok: false, reason: 'send-failed' },
    ];
    const texts = results.map((result) => pasteToast(result));
    texts.forEach((item) => expect(item.tone).toBe('warn'));
    expect(texts[0]?.text).toBe('已复制，按 Ctrl+V 粘贴');
    expect(texts[1]?.text).toBe('目标窗口以管理员运行，无法自动粘贴（已复制）');
    expect(texts[2]?.text).toBe('已复制，但自动粘贴失败，请按 Ctrl+V');
    expect(new Set(texts.map((item) => item.text)).size).toBe(3);
  });

  it('没给 reason 的失败按「自动粘贴失败」处理', () => {
    expect(pasteToast({ ok: false }).text).toBe('已复制，但自动粘贴失败，请按 Ctrl+V');
  });
});

describe('mergeToast 文案', () => {
  it('成功时报拼接条数，ok 色调', () => {
    expect(mergeToast({ ok: true, id: 'm1' }, 3)).toEqual({
      text: '已把 3 条拼接为 1 条',
      tone: 'ok',
    });
  });

  it('成功且跳过图片时补一句', () => {
    expect(mergeToast({ ok: true, id: 'm1' }, 3, 2).text).toBe(
      '已把 3 条拼接为 1 条（已跳过 2 条图片）',
    );
  });

  it('三种拒绝理由各给不同文案，且都是 warn 色调', () => {
    const reasons = ['not-enough', 'pinned', 'images-skipped'];
    const items = reasons.map((reason) => mergeToast({ ok: false, reason }, 2, 1));
    items.forEach((item) => expect(item.tone).toBe('warn'));
    expect(items[0]?.text).toBe('拼接需要至少 2 条，按住 Ctrl 或 Shift 多选几条再按 Ctrl+M');
    expect(items[1]?.text).toBe('拼接需要至少 2 条未收藏记录，收藏项不会被合并');
    expect(items[2]?.text).toBe('图片不参与拼接，已跳过 1 条');
    expect(new Set(items.map((item) => item.text)).size).toBe(3);
  });

  it('未知失败原因给兜底文案', () => {
    expect(mergeToast({ ok: false, reason: 'unknown' }, 2).text).toBe('拼接失败，请重试');
    expect(mergeToast({ ok: false }, 2).text).toBe('拼接失败，请重试');
  });
});

describe('幽灵模式文案', () => {
  it('开启提示带时长', () => {
    expect(ghostOnToast(30)).toBe('幽灵模式已开启，接下来 30 分钟内不记录剪贴板');
  });

  it('★ 跳过提示必须写明「结束后也不会补录」', () => {
    expect(GHOST_SKIP_TOAST).toContain('没有记录');
    expect(GHOST_SKIP_TOAST).toContain('结束后也不会补录');
  });

  it('恢复提示与跳过提示不是同一句', () => {
    expect(GHOST_RESUME_TOAST).not.toBe(GHOST_SKIP_TOAST);
    expect(GHOST_RESUME_TOAST).toContain('监听已恢复');
  });
});
