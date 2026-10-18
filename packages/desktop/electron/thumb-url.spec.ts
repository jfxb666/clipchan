/**
 * 缩略图协议纯函数单测（`clipchan-img:`）。
 *
 * ★ 回归背景：真机上图片卡片的缩略图显示为**破图图标** —— 库里存的是相对路径
 *   `thumbs/<id>.png`，渲染层直接当 src 用 → 解析成 `file://.../dist/thumbs/...` → 404。
 *   这个文件钉死翻译与解析两侧，防止再退化。
 */
import { describe, expect, it } from 'vitest';
import {
  THUMB_SCHEME,
  imageUrlFor,
  mapThumbUrl,
  resolveImageRequest,
  resolveThumbRequest,
  thumbUrlFor,
} from './thumb-url';

const DATA_DIR = 'C:\\Users\\me\\AppData\\Roaming\\Clipchan';

describe('thumbUrlFor：相对路径 → 协议 URL', () => {
  it('把 thumbs/<id>.png 翻成 clipchan-img://thumb/thumbs/<id>.png', () => {
    expect(thumbUrlFor('thumbs/i1.png')).toBe('clipchan-img://thumb/thumbs/i1.png');
  });

  it('反斜杠分隔符也认（Windows 上可能混用）', () => {
    expect(thumbUrlFor('thumbs\\i1.png')).toBe('clipchan-img://thumb/thumbs/i1.png');
  });

  it('文件名里的空格与中文会被编码，解析回来仍是原文件名', () => {
    const url = thumbUrlFor('thumbs/我的 图.png');
    expect(url).toBe('clipchan-img://thumb/thumbs/%E6%88%91%E7%9A%84%20%E5%9B%BE.png');
    expect(resolveThumbRequest(url!, DATA_DIR)).toBe(DATA_DIR + '\\thumbs\\我的 图.png');
  });

  it('★ 只放行 thumbs/ 前缀：原图 images/ 一律拒绝', () => {
    expect(thumbUrlFor('images/i1.jpg')).toBeUndefined();
    expect(thumbUrlFor('clipchan.db')).toBeUndefined();
  });

  it('路径穿越与空值一律拒绝', () => {
    expect(thumbUrlFor('thumbs/../../secret.png')).toBeUndefined();
    expect(thumbUrlFor('../thumbs/i1.png')).toBeUndefined();
    expect(thumbUrlFor('thumbs/./i1.png')).toBeUndefined();
    expect(thumbUrlFor('')).toBeUndefined();
    expect(thumbUrlFor(null)).toBeUndefined();
    expect(thumbUrlFor(undefined)).toBeUndefined();
  });
});

describe('resolveThumbRequest：协议 URL → 磁盘路径', () => {
  it('解析到 <dataDir>/thumbs/<id>.png', () => {
    const url = 'clipchan-img://thumb/thumbs/i1.png';
    expect(resolveThumbRequest(url, DATA_DIR)).toBe(DATA_DIR + '\\thumbs\\i1.png');
  });

  it('★ 路径穿越被挡下（编码后的 .. 也不行）', () => {
    expect(resolveThumbRequest('clipchan-img://thumb/thumbs/../../evil.png', DATA_DIR)).toBeNull();
    expect(resolveThumbRequest('clipchan-img://thumb/thumbs/%2e%2e/evil.png', DATA_DIR)).toBeNull();
    expect(resolveThumbRequest('clipchan-img://thumb/../evil.png', DATA_DIR)).toBeNull();
  });

  it('★ 别的 scheme / 主机名一律拒绝', () => {
    expect(resolveThumbRequest('file:///C:/x/thumbs/i1.png', DATA_DIR)).toBeNull();
    expect(resolveThumbRequest('clipchan-img://evil/thumbs/i1.png', DATA_DIR)).toBeNull();
    expect(resolveThumbRequest('https://example.com/thumbs/i1.png', DATA_DIR)).toBeNull();
    expect(resolveThumbRequest('not a url', DATA_DIR)).toBeNull();
    expect(resolveThumbRequest('', DATA_DIR)).toBeNull();
  });

  it('★ 只允许 thumbs/ 顶层目录', () => {
    expect(resolveThumbRequest('clipchan-img://thumb/images/i1.jpg', DATA_DIR)).toBeNull();
    expect(resolveThumbRequest('clipchan-img://thumb/thumbs', DATA_DIR)).toBeNull();
  });
});

describe('原图协议（image 主机）：查看大图', () => {
  it('images/<id>.png 翻成 clipchan-img://image/images/<id>.png', () => {
    expect(imageUrlFor('images/i1.png')).toBe('clipchan-img://image/images/i1.png');
  });

  it('★ 与缩略图分属两个主机，不能互相冒充', () => {
    expect(imageUrlFor('thumbs/i1.png')).toBeUndefined();
    expect(thumbUrlFor('images/i1.png')).toBeUndefined();
    const thumbUrl = 'clipchan-img://thumb/thumbs/i1.png';
    const imgUrl = 'clipchan-img://image/images/i1.png';
    expect(resolveImageRequest(thumbUrl, DATA_DIR)).toBeNull();
    expect(resolveThumbRequest(imgUrl, DATA_DIR)).toBeNull();
  });

  it('解析到 <dataDir>/images/<id>.png', () => {
    expect(resolveImageRequest('clipchan-img://image/images/i1.png', DATA_DIR)).toBe(
      DATA_DIR + '\\images\\i1.png',
    );
  });

  it('★ 路径穿越与非法 scheme 一律拒绝', () => {
    expect(resolveImageRequest('clipchan-img://image/images/../../evil.png', DATA_DIR)).toBeNull();
    expect(resolveImageRequest('clipchan-img://image/images/%2e%2e/evil.png', DATA_DIR)).toBeNull();
    expect(resolveImageRequest('file:///C:/x/images/i1.png', DATA_DIR)).toBeNull();
    expect(resolveImageRequest('clipchan-img://image/thumbs/i1.png', DATA_DIR)).toBeNull();
    expect(resolveImageRequest('', DATA_DIR)).toBeNull();
  });

  it('文件名含中文与空格时编码后仍能解析回原路径', () => {
    const url = imageUrlFor('images/我的 图.jpg');
    expect(resolveImageRequest(url!, DATA_DIR)).toBe(DATA_DIR + '\\images\\我的 图.jpg');
  });

  it('空值与穿越输入 → undefined（宁可不显示，也不给坏 URL）', () => {
    expect(imageUrlFor('')).toBeUndefined();
    expect(imageUrlFor(null)).toBeUndefined();
    expect(imageUrlFor(undefined)).toBeUndefined();
    expect(imageUrlFor('images/../evil.png')).toBeUndefined();
    expect(imageUrlFor('images')).toBeUndefined();
  });
});

describe('mapThumbUrl：DTO 投影', () => {
  it('相对路径换成协议 URL，其余字段逐字保留', () => {
    const dto = { id: 'i1', kind: 'image', preview: '图片 400×300 · 2 KB', thumbUrl: 'thumbs/i1.png' };
    const out = mapThumbUrl(dto);
    expect(out.thumbUrl).toBe('clipchan-img://thumb/thumbs/i1.png');
    expect(out.id).toBe('i1');
    expect(out.preview).toBe('图片 400×300 · 2 KB');
    expect(out.kind).toBe('image');
  });

  it('★ 幂等：已经是协议 URL 的原样返回（同一引用）', () => {
    const dto = { id: 'i1', thumbUrl: 'clipchan-img://thumb/thumbs/i1.png' };
    expect(mapThumbUrl(dto)).toBe(dto);
  });

  it('没有缩略图的 DTO 原样返回（同一引用，方便上层 memo）', () => {
    const dto = { id: 't1', preview: 'hello' };
    expect(mapThumbUrl(dto)).toBe(dto);
  });

  it('★ 非法相对路径 → 去掉 thumbUrl（界面回落占位图标，而不是破图）', () => {
    const bad = mapThumbUrl({ id: 'i1', thumbUrl: 'images/i1.jpg' });
    expect(bad.thumbUrl).toBeUndefined();
    expect('thumbUrl' in bad).toBe(false);
  });

  it('scheme 常量与 CSP 里写的一致', () => {
    expect(THUMB_SCHEME).toBe('clipchan-img');
  });
});