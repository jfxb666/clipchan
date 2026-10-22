import { describe, expect, it } from 'vitest';
import { parseCfHtml, parseCfHtmlOffsets } from './cfhtml';

/**
 * 造一个 CF_HTML 缓冲：头部偏移量按真实字节算，正文用 UTF-8 ——
 * 这正是 Windows 上 Office 写出来的形态（偏移是字节偏移，不是字符偏移）。
 */
function buildCfHtml(
  html: string,
  opts: { fragment?: string; omit?: 'EndHTML' | 'StartFragment' | 'EndFragment' } = {},
): Buffer {
  const fragment = opts.fragment ?? '';
  const headerPad = 'Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n\r\n';
  const headerBytes = Buffer.byteLength(headerPad, 'latin1');
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const fragBytes = Buffer.byteLength(fragment, 'utf8');
  const startHtml = headerBytes;
  const endHtml = startHtml + htmlBytes;
  // 片段默认落在整篇开头（够测），显式给了就把片段接在文档后面
  const startFragment = fragment.length > 0 ? endHtml : startHtml;
  const endFragment = startFragment + (fragment.length > 0 ? fragBytes : htmlBytes);
  const pad = (n: number) => String(n).padStart(10, '0');
  const lines: string[] = ['Version:1.0'];
  lines.push('StartHTML:' + pad(startHtml));
  if (opts.omit !== 'EndHTML') lines.push('EndHTML:' + pad(endHtml));
  lines.push('StartFragment:' + pad(startFragment));
  if (opts.omit !== 'EndFragment') lines.push('EndFragment:' + pad(endFragment));
  const header = lines.join('\r\n') + '\r\n\r\n';
  // 头部长度必须和 startHtml 对齐，短了就补空格（CF_HTML 允许头部带填充）
  const padLen = headerBytes - Buffer.byteLength(header, 'latin1');
  const padded = header + ' '.repeat(Math.max(0, padLen));
  return Buffer.concat([Buffer.from(padded, 'latin1'), Buffer.from(html + fragment, 'utf8')]);
}

describe('parseCfHtmlOffsets', () => {
  it('取出四个偏移量', () => {
    const buf = buildCfHtml('<html><body><p>hi</p></body></html>');
    const off = parseCfHtmlOffsets(buf);
    expect(off).not.toBeNull();
    expect(off!.startHtml).toBeGreaterThan(0);
    expect(off!.endHtml).toBeGreaterThan(off!.startHtml);
  });

  it('空 / null / 非 CF_HTML 一律回 null', () => {
    expect(parseCfHtmlOffsets(null)).toBeNull();
    expect(parseCfHtmlOffsets(undefined)).toBeNull();
    expect(parseCfHtmlOffsets(Buffer.alloc(0))).toBeNull();
    expect(parseCfHtmlOffsets(Buffer.from('hello world', 'utf8'))).toBeNull();
  });

  it('只有 StartHTML 没有 StartFragment 也能解析（Word 之外的实现）', () => {
    const header = 'Version:1.0\r\nStartHTML:0000000100\r\nEndHTML:0000000130\r\n\r\n';
    const buf = Buffer.concat([
      Buffer.from(header.padEnd(100, ' '), 'latin1'),
      Buffer.from('<p>x</p>'.padEnd(30, ' '), 'utf8'),
    ]);
    const off = parseCfHtmlOffsets(buf);
    expect(off!.startHtml).toBe(100);
    expect(off!.startFragment).toBe(-1);
  });

  it('正文里出现 StartFragment: 字样不会污染头部解析', () => {
    const html = '<p>StartFragment:0000009999</p>';
    const buf = buildCfHtml(html);
    const off = parseCfHtmlOffsets(buf)!;
    expect(off.startFragment).toBeLessThan(off.endHtml);
  });
});

describe('parseCfHtml', () => {
  it('取完整文档（含 html/head/style），不是片段', () => {
    const html = '<html><head><style>.xl63{font-weight:700}</style></head><body><table><tr><td class=xl63>Name</td></tr></table></body></html>';
    const buf = buildCfHtml(html);
    expect(parseCfHtml(buf)).toBe(html);
  });

  it('★ 含中文时按字节偏移切，不会切歪', () => {
    const html = '<html><body><p>手工验收已完成</p></body></html>';
    const buf = buildCfHtml(html);
    expect(parseCfHtml(buf)).toBe(html);
  });

  it('EndHTML 越界时截到缓冲末尾，不抛', () => {
    const html = '<p>abc</p>';
    const buf = buildCfHtml(html);
    // 手工把 EndHTML 改大
    const s = buf.toString('latin1');
    const broken = Buffer.from(s.replace(/EndHTML:\\d{10}/, 'EndHTML:0000999999'), 'latin1');
    expect(parseCfHtml(broken)).toBe(html);
  });

  it('没有完整区间时退回片段', () => {
    // StartHTML/EndHTML 缺失、只有片段区间 —— 有些实现就是这么写的
    const frag = '<table><tr><td>Name</td></tr></table>';
    const header = 'Version:1.0\r\nStartFragment:0000000100\r\nEndFragment:0000000140\r\n\r\n';
    const buf = Buffer.concat([Buffer.from(header.padEnd(100, ' '), 'latin1'), Buffer.from(frag, 'utf8')]);
    expect(parseCfHtml(buf)).toBe(frag);
  });

  it('StartHTML 落在头部之内（坏数据）回 null 或片段，不抛', () => {
    const header = 'Version:1.0\r\nStartHTML:0000000005\r\nEndHTML:0000000020\r\n\r\n';
    const buf = Buffer.from(header, 'latin1');
    expect(() => parseCfHtml(buf)).not.toThrow();
  });

  it('null / 空 / 非 CF_HTML 回 null', () => {
    expect(parseCfHtml(null)).toBeNull();
    expect(parseCfHtml(Buffer.alloc(0))).toBeNull();
    expect(parseCfHtml(Buffer.from('plain text', 'utf8'))).toBeNull();
  });

  it('EndHTML 小于 StartHTML（坏数据）回 null 而不是负长度切片', () => {
    const header = 'Version:1.0\r\nStartHTML:0000000200\r\nEndHTML:0000000100\r\nStartFragment:0000000200\r\nEndFragment:0000000100\r\n\r\n';
    const buf = Buffer.concat([Buffer.from(header.padEnd(200, ' '), 'latin1'), Buffer.from('<p>x</p>', 'utf8')]);
    expect(parseCfHtml(buf)).toBeNull();
  });
});
