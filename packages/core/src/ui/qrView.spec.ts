import { describe, expect, it } from 'vitest';
import { qrLooksLikeUrl, qrMessageOf, qrStatusOf, type QrStatus } from './qrView';

describe('qrStatusOf', () => {
  it('还没开始（result 与 error 都是 null）→ idle', () => {
    expect(qrStatusOf(null, null)).toBe('idle');
  });

  it('有结果 → found', () => {
    expect(qrStatusOf('https://example.com', null)).toBe('found');
  });

  it('空白结果 → empty（主进程约定未识别到返回空串）', () => {
    expect(qrStatusOf('', null)).toBe('empty');
    expect(qrStatusOf('   \n\t ', null)).toBe('empty');
  });

  it('有 error → error', () => {
    expect(qrStatusOf(null, '识别失败')).toBe('error');
  });

  it('error 优先于 result：有结果也报 error', () => {
    expect(qrStatusOf('https://example.com', '识别失败')).toBe('error');
  });

  it('空白 error 不算 error（退回按 result 判）', () => {
    expect(qrStatusOf('https://example.com', '   ')).toBe('found');
    expect(qrStatusOf(null, '')).toBe('idle');
  });
});

describe('qrMessageOf', () => {
  it('loading → 正在识别…', () => {
    expect(qrMessageOf('loading')).toBe('正在识别…');
  });

  it('empty → 没找到二维码', () => {
    expect(qrMessageOf('empty')).toBe('这张图里没找到二维码');
  });

  it('error → 识别失败', () => {
    expect(qrMessageOf('error')).toBe('识别失败');
  });

  it('found / idle 没有文案（结果自己就显示在那儿）', () => {
    expect(qrMessageOf('found')).toBe('');
    expect(qrMessageOf('idle')).toBe('');
  });

  it('每个状态都有确定的返回值，不留 undefined', () => {
    const all: QrStatus[] = ['idle', 'loading', 'found', 'empty', 'error'];
    for (const status of all) expect(typeof qrMessageOf(status)).toBe('string');
  });
});

describe('qrLooksLikeUrl', () => {
  it('http / https 开头 → true', () => {
    expect(qrLooksLikeUrl('http://example.com')).toBe(true);
    expect(qrLooksLikeUrl('https://example.com/a?b=1')).toBe(true);
  });

  it('大写协议与首尾空白也认（先 trim 再判）', () => {
    expect(qrLooksLikeUrl('  HTTPS://Example.com  ')).toBe(true);
  });

  it('其它协议 → false', () => {
    expect(qrLooksLikeUrl('ftp://example.com')).toBe(false);
    expect(qrLooksLikeUrl('tel:13800000000')).toBe(false);
    expect(qrLooksLikeUrl('mailto:a@b.c')).toBe(false);
  });

  it('不是 URL 的普通文本 → false', () => {
    expect(qrLooksLikeUrl('example.com')).toBe(false);
    expect(qrLooksLikeUrl('这是一段文字')).toBe(false);
    expect(qrLooksLikeUrl('')).toBe(false);
  });
});
