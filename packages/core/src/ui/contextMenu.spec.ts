import { describe, expect, it } from 'vitest';
import { clampMenuPosition, menuItemsFor } from './contextMenu';

const actions = (item: Parameters<typeof menuItemsFor>[0]) => menuItemsFor(item).map((entry) => entry.action);
const labels = (item: Parameters<typeof menuItemsFor>[0]) => menuItemsFor(item).map((entry) => entry.label);

describe('menuItemsFor', () => {
  it('图片没有 optimize', () => {
    expect(actions({ kind: 'image', pinned: false })).not.toContain('optimize');
  });

  it('图片有 view，文案是「查看大图」', () => {
    const view = menuItemsFor({ kind: 'image', pinned: false }).find((entry) => entry.action === 'view');
    expect(view?.label).toBe('查看大图');
  });

  it('文本 truncated 有 view，文案是「查看全文」', () => {
    const view = menuItemsFor({ kind: 'text', pinned: false, truncated: true }).find(
      (entry) => entry.action === 'view',
    );
    expect(view?.label).toBe('查看全文');
  });

  it('hasFullText 也算有 view', () => {
    expect(actions({ kind: 'code', pinned: false, hasFullText: true })).toContain('view');
  });

  it('普通文本没有 view', () => {
    expect(actions({ kind: 'text', pinned: false })).not.toContain('view');
    expect(actions({ kind: 'link', pinned: false, truncated: false })).not.toContain('view');
  });

  it('pinned 切换「收藏 / 取消收藏」', () => {
    expect(labels({ kind: 'text', pinned: false })).toContain('收藏');
    expect(labels({ kind: 'text', pinned: true })).toContain('取消收藏');
    expect(labels({ kind: 'text', pinned: true })).not.toContain('收藏');
  });

  it('顺序：view → copy → paste → paste-plain → optimize → pin → remove', () => {
    expect(actions({ kind: 'text', pinned: false, truncated: true })).toEqual([
      'view',
      'copy',
      'paste',
      'paste-plain',
      'optimize',
      'pin',
      'remove',
    ]);
    expect(actions({ kind: 'image', pinned: true })).toEqual(['view', 'ocr', 'copy', 'paste', 'pin', 'remove']);
  });

  it('文本记录有 paste-plain，且紧跟在 paste 之后', () => {
    const list = actions({ kind: 'text', pinned: false });
    expect(list).toContain('paste-plain');
    expect(list.indexOf('paste-plain')).toBe(list.indexOf('paste') + 1);
    const plain = menuItemsFor({ kind: 'text', pinned: false }).find((e) => e.action === 'paste-plain');
    expect(plain?.label).toBe('粘贴为纯文本');
  });

  it('图片记录没有 paste-plain（没有纯文本可贴）', () => {
    expect(actions({ kind: 'image', pinned: false })).not.toContain('paste-plain');
  });

  it('图片菜单有 ocr 项，文案是「识别文字」', () => {
    const ocr = menuItemsFor({ kind: 'image', pinned: false }).find((entry) => entry.action === 'ocr');
    expect(ocr?.label).toBe('识别文字');
  });

  it('ocr 紧跟在 view 之后（图片第一意图是看图，第二才是认字）', () => {
    expect(actions({ kind: 'image', pinned: false })).toEqual(['view', 'ocr', 'copy', 'paste', 'pin', 'remove']);
  });

  it('文本菜单没有 ocr 项', () => {
    expect(actions({ kind: 'text', pinned: false })).not.toContain('ocr');
    expect(actions({ kind: 'code', pinned: false, hasFullText: true })).not.toContain('ocr');
    expect(actions({ kind: 'link', pinned: false })).not.toContain('ocr');
  });

  it('remove 带 danger，pin 带 Ctrl+D 提示，其余不带', () => {
    const items = menuItemsFor({ kind: 'text', pinned: false });
    expect(items.find((entry) => entry.action === 'remove')?.danger).toBe(true);
    expect(items.find((entry) => entry.action === 'pin')?.hint).toBe('Ctrl+D');
    expect(items.find((entry) => entry.action === 'copy')?.danger).toBeUndefined();
  });
});

describe('clampMenuPosition', () => {
  const size = { width: 200, height: 100 };
  const viewport = { width: 800, height: 600 };

  it('右下越界时上翻并右钳', () => {
    expect(clampMenuPosition(790, 590, size, viewport)).toEqual({ x: 592, y: 490 });
  });

  it('不越左上界（负坐标被钳到 margin）', () => {
    expect(clampMenuPosition(-40, -40, size, viewport)).toEqual({ x: 8, y: 8 });
  });

  it('空间充足时原样返回', () => {
    expect(clampMenuPosition(300, 200, size, viewport)).toEqual({ x: 300, y: 200 });
  });

  it('上翻后仍为负时钳到 margin', () => {
    const tall = { width: 200, height: 400 };
    expect(clampMenuPosition(100, 250, tall, viewport).y).toBe(8);
  });

  it('margin 可自定义', () => {
    expect(clampMenuPosition(0, 0, size, viewport, 20)).toEqual({ x: 20, y: 20 });
  });

  it('视口比菜单还小时不让左上角出屏', () => {
    const huge = { width: 900, height: 700 };
    expect(clampMenuPosition(500, 500, huge, { width: 400, height: 300 })).toEqual({ x: 8, y: 8 });
  });
});
