/**
 * 拖出参数计算（P1-5）的单测。
 *
 * 只测纯逻辑：不碰 electron、不碰真文件系统 —— `imageAbs` 是注入的。
 */
import { describe, expect, it } from 'vitest';
import {
  DRAG_HINT_MULTI_FILE,
  DRAG_HINT_TEXT,
  dragHintFor,
  dragPayloadFor,
  type DragFileSpec,
} from './dragout';

const imageAbs = (rel: string): string => 'C:\\data\\Clipchan\\' + rel.replace(/\//g, '\\');

/** 造一个最小的 opts（dataDir 只用于 imageAbs，本模块不直接读它）。 */
function opts(filePaths: string[] = []): {
  dataDir: string;
  filePaths: string[];
  imageAbs: (rel: string) => string;
} {
  return { dataDir: 'C:\\data\\Clipchan', filePaths, imageAbs };
}

describe('dragPayloadFor', () => {
  it('记录不存在 → null', () => {
    expect(dragPayloadFor('gone', null, opts())).toBeNull();
  });

  it('图片记录 → file 是 imageAbs 解析出的原图，icon 与 file 相同', () => {
    const r = dragPayloadFor('i1', { kind: 'image', image_path: 'images/i1.png' }, opts());
    expect(r).toEqual({
      file: 'C:\\data\\Clipchan\\images\\i1.png',
      icon: 'C:\\data\\Clipchan\\images\\i1.png',
    });
  });

  it('图片记录 image_path 为空 → null', () => {
    expect(dragPayloadFor('i1', { kind: 'image', image_path: null }, opts())).toBeNull();
    expect(dragPayloadFor('i1', { kind: 'image', image_path: '' }, opts())).toBeNull();
  });

  it('imageAbs 解析不出路径（回空串）→ null（绝不把空路径交给 startDrag）', () => {
    const r = dragPayloadFor('i1', { kind: 'image', image_path: 'images/i1.png' }, {
      dataDir: '',
      filePaths: [],
      imageAbs: () => '',
    });
    expect(r).toBeNull();
  });

  it('单文件记录 → file 就是那个路径，icon 为空串（调用方补默认图标）', () => {
    const r = dragPayloadFor('f1', { kind: 'files', image_path: null }, opts(['D:\\a\\报告.pdf']));
    expect(r).toEqual({ file: 'D:\\a\\报告.pdf', icon: '' });
  });

  it('多文件记录 → null（startDrag 一次只能拖一个文件，本轮不做 helper）', () => {
    const r = dragPayloadFor('f1', { kind: 'files', image_path: null }, opts(['D:\\a.txt', 'D:\\b.txt']));
    expect(r).toBeNull();
  });

  it('文件路径列表为空 → null', () => {
    expect(dragPayloadFor('f1', { kind: 'files', image_path: null }, opts())).toBeNull();
  });

  it('文件路径列表里混了空串：过滤后只剩一个仍可拖', () => {
    const r = dragPayloadFor('f1', { kind: 'files', image_path: null }, opts(['', 'D:\\a.txt', '']));
    expect(r).toEqual({ file: 'D:\\a.txt', icon: '' });
  });

  it('文本类记录（text/link/code/path/number）→ null，拖文本本轮不做', () => {
    for (const kind of ['text', 'link', 'code', 'path', 'number']) {
      expect(dragPayloadFor('t1', { kind, image_path: null }, opts(['D:\\a.txt']))).toBeNull();
    }
  });

  it('返回值形状满足 DragFileSpec（file 必填、icon 可选）', () => {
    const spec: DragFileSpec = { path: 'D:\\a.txt' };
    expect(spec.icon).toBeUndefined();
    const r = dragPayloadFor('f1', { kind: 'files', image_path: null }, opts(['D:\\a.txt']));
    expect(r).not.toBeNull();
    expect(typeof r!.file).toBe('string');
    expect(typeof r!.icon).toBe('string');
  });

  it('不读 id（id 只是给调用方对照用）', () => {
    const a = dragPayloadFor('x', { kind: 'files', image_path: null }, opts(['D:\\a.txt']));
    const b = dragPayloadFor('y', { kind: 'files', image_path: null }, opts(['D:\\a.txt']));
    expect(a).toEqual(b);
  });
});

describe('dragHintFor', () => {
  it('image / files → null（可拖，不显示原因）', () => {
    expect(dragHintFor('image')).toBeNull();
    expect(dragHintFor('files')).toBeNull();
  });

  it('文本类 → 中文原因', () => {
    for (const kind of ['text', 'link', 'code', 'path', 'number']) {
      expect(dragHintFor(kind)).toBe(DRAG_HINT_TEXT);
    }
    expect(dragHintFor('text')).toBe('文本记录暂时不能拖出');
  });

  it('未知 kind 也回文本原因（不假装可拖）', () => {
    expect(dragHintFor('whatever')).toBe(DRAG_HINT_TEXT);
    expect(dragHintFor('')).toBe(DRAG_HINT_TEXT);
  });

  it('多文件的具体原因由调用方用常量补（kind 层面仍是 files）', () => {
    expect(DRAG_HINT_MULTI_FILE).toBe('多文件暂时不能拖出');
    expect(dragHintFor('files')).toBeNull();
  });
});
