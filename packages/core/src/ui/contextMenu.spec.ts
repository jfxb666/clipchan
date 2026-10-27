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

  // ⑥ 智能整理加了两项（tags / folder）、v1.0.0 ⑤ 又加了 assist 之后，这条完整顺序断言
  // 必须同步——完整顺序断言天生钉住整个数组，多一项就红。期望值只补新增项、位置即真实
  // 插入位置，语义不变。图片那一份**不补** assist：AI 助手只处理文本。
  it('顺序：view → copy → paste → paste-plain → optimize → assist → tags → folder → pin → remove', () => {
    expect(actions({ kind: 'text', pinned: false, truncated: true })).toEqual([
      'view',
      'copy',
      'paste',
      'paste-plain',
      'optimize',
      'assist',
      'tags',
      'folder',
      'pin',
      'remove',
    ]);
    expect(actions({ kind: 'image', pinned: true })).toEqual([
      'view',
      'ocr',
      'qr',
      'copy',
      'paste',
      'tags',
      'folder',
      'pin',
      'remove',
    ]);
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
    expect(actions({ kind: 'image', pinned: false })).toEqual([
      'view',
      'ocr',
      'qr',
      'copy',
      'paste',
      'tags',
      'folder',
      'pin',
      'remove',
    ]);
  });

  it('文本菜单没有 ocr 项', () => {
    expect(actions({ kind: 'text', pinned: false })).not.toContain('ocr');
    expect(actions({ kind: 'code', pinned: false, hasFullText: true })).not.toContain('ocr');
    expect(actions({ kind: 'link', pinned: false })).not.toContain('ocr');
  });

  // 二维码识别与 OCR 是同一类意图（把图里的信息抠出来），所以紧挨着 ocr 而不是排到末尾。
  it('图片菜单有 qr 项，且紧跟 ocr', () => {
    const list = actions({ kind: 'image', pinned: false });
    expect(list).toContain('qr');
    expect(list.indexOf('qr')).toBe(list.indexOf('ocr') + 1);
  });

  it('qr 只对图片出现（文本记录没有像素可解）', () => {
    for (const kind of ['text', 'link', 'code', 'path', 'number', 'file-list', 'files']) {
      expect(actions({ kind, pinned: false })).not.toContain('qr');
    }
  });

  it('qr 文案是「识别二维码」，不带省略号（点了立刻识别，不再二次选择）', () => {
    const qr = menuItemsFor({ kind: 'image', pinned: false }).find((entry) => entry.action === 'qr');
    expect(qr?.label).toBe('识别二维码');
    expect(qr?.label?.endsWith('…')).toBe(false);
  });

  // v1.0.0 ⑥ 智能整理：标签 / 文件夹两项。它们是**记录级**属性（items.tags、
  // items.folder_id 与 kind 无关），所以文本与图片都要给 —— 用例把这层契约钉住。
  it('标签与文件夹两项对文本和图片都给（记录级属性，与 kind 无关）', () => {
    for (const kind of ['text', 'image', 'link', 'code', 'path', 'number', 'file-list']) {
      expect(actions({ kind, pinned: false })).toContain('tags');
      expect(actions({ kind, pinned: false })).toContain('folder');
    }
  });

  it('标签 / 文件夹排在 optimize 之后、pin 之前（加工类动作在前，去留类收尾在后）', () => {
    const list = actions({ kind: 'text', pinned: false });
    expect(list.indexOf('tags')).toBeGreaterThan(list.indexOf('optimize'));
    expect(list.indexOf('folder')).toBe(list.indexOf('tags') + 1);
    expect(list.indexOf('folder')).toBeLessThan(list.indexOf('pin'));
  });

  // v1.0.0 ⑤ 剪贴板 AI 助手：只给文本，且紧跟在 optimize 之后（同属「对文本做加工」）。
  it('文本记录菜单有 assist 项，文案是「AI 助手…」（带省略号）', () => {
    const assist = menuItemsFor({ kind: 'text', pinned: false }).find((entry) => entry.action === 'assist');
    expect(assist?.label).toBe('AI 助手…');
    expect(assist?.label?.endsWith('…')).toBe(true);
  });

  it('assist 紧跟在 optimize 之后（两者都是对文本做加工）', () => {
    const list = actions({ kind: 'text', pinned: false });
    expect(list).toContain('assist');
    expect(list.indexOf('assist')).toBe(list.indexOf('optimize') + 1);
  });

  it('assist 只对文本出现：图片记录菜单没有 assist', () => {
    expect(actions({ kind: 'image', pinned: false })).not.toContain('assist');
    for (const kind of ['text', 'link', 'code', 'path', 'number', 'file-list', 'files']) {
      expect(actions({ kind, pinned: false })).toContain('assist');
    }
  });

  it('图片没有 optimize，标签仍紧跟在 paste 之后', () => {
    const list = actions({ kind: 'image', pinned: false });
    expect(list).not.toContain('optimize');
    expect(list.indexOf('tags')).toBe(list.indexOf('paste') + 1);
  });

  it('两项的文案带省略号（点了还要再选，不是立即执行）', () => {
    const items = menuItemsFor({ kind: 'text', pinned: false });
    expect(items.find((entry) => entry.action === 'tags')?.label).toBe('标签…');
    expect(items.find((entry) => entry.action === 'folder')?.label).toBe('移动到文件夹…');
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
