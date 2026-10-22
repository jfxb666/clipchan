import { describe, it, expect } from 'vitest';
import {
  MAX_FILES,
  baseNameOf,
  buildDropFiles,
  filesDesc,
  parseDropFiles,
  parseUriList,
} from './dropfiles';

/**
 * CF_HDROP 字节布局是这一版最容易写错、又最难在界面上看出来的地方
 * （错了的表现只是"粘贴文件没反应"）。所以这里把布局逐字节钉住。
 */
describe('buildDropFiles / parseDropFiles：DROPFILES 布局', () => {
  it('头部 20 字节：pFiles=20、pt=0、fNC=0、fWide=1', () => {
    const buf = buildDropFiles(['C:\\a.txt']);
    expect(buf.readUInt32LE(0)).toBe(20); // pFiles
    expect(buf.readInt32LE(4)).toBe(0); // pt.x
    expect(buf.readInt32LE(8)).toBe(0); // pt.y
    expect(buf.readUInt32LE(12)).toBe(0); // fNC
    expect(buf.readUInt32LE(16)).toBe(1); // fWide = UTF-16LE
  });

  it('路径以 UTF-16LE 写入、每条一个 \\0，列表末尾再补一个 \\0', () => {
    const buf = buildDropFiles(['C:\\a.txt']);
    const pathBytes = Buffer.byteLength('C:\\a.txt', 'utf16le');
    expect(buf.length).toBe(20 + pathBytes + 2 + 2);
    expect(buf.toString('utf16le', 20, 20 + pathBytes)).toBe('C:\\a.txt');
    expect(buf.readUInt16LE(20 + pathBytes)).toBe(0);
    expect(buf.readUInt16LE(20 + pathBytes + 2)).toBe(0);
  });

  it('多条路径往返一致', () => {
    const paths = ['C:\\Users\\a\\1.txt', 'D:\\b\\2.png', 'C:\\中文目录\\三.txt'];
    expect(parseDropFiles(buildDropFiles(paths))).toEqual(paths);
  });

  it('空数组编成"只有头 + 终止符"的合法结构，解出来是空', () => {
    const buf = buildDropFiles([]);
    expect(buf.length).toBe(22);
    expect(parseDropFiles(buf)).toEqual([]);
  });

  it('超过 MAX_FILES 的部分被截掉（复制整个文件夹时可能是几千个）', () => {
    const many = Array.from({ length: MAX_FILES + 10 }, (_v, i) => 'C:\\f' + i + '.txt');
    expect(parseDropFiles(buildDropFiles(many)).length).toBe(MAX_FILES);
  });
});

describe('parseDropFiles：坏数据一律返回空数组，绝不抛', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空缓冲', Buffer.alloc(0)],
    ['不足 20 字节', Buffer.alloc(19)],
  ])('%s', (_name, input) => {
    expect(parseDropFiles(input as Buffer | null | undefined)).toEqual([]);
  });

  it('pFiles 指向头部内 → 空', () => {
    const buf = Buffer.alloc(40);
    buf.writeUInt32LE(4, 0); // pFiles = 4，落在头里
    buf.writeUInt32LE(1, 16);
    expect(parseDropFiles(buf)).toEqual([]);
  });

  it('pFiles 超出缓冲长度 → 空', () => {
    const buf = Buffer.alloc(40);
    buf.writeUInt32LE(999, 0);
    buf.writeUInt32LE(1, 16);
    expect(parseDropFiles(buf)).toEqual([]);
  });

  it('没有终止符的截断数据也能解出前面的完整路径（不抛、不越界）', () => {
    const full = buildDropFiles(['C:\\a.txt', 'C:\\b.txt']);
    const cut = full.subarray(0, full.length - 4);
    expect(parseDropFiles(cut)).toEqual(['C:\\a.txt']);
  });

  it('fWide = 0（ANSI 老格式）也能解', () => {
    const head = Buffer.alloc(20);
    head.writeUInt32LE(20, 0);
    head.writeUInt32LE(0, 16);
    const body = Buffer.from('C:\\legacy.txt\0\0', 'latin1');
    expect(parseDropFiles(Buffer.concat([head, body]))).toEqual(['C:\\legacy.txt']);
  });
});

describe('parseUriList：text/uri-list 兜底', () => {
  it('file:///C:/x/a.txt → Windows 路径', () => {
    expect(parseUriList('file:///C:/x/a.txt')).toEqual(['C:\\x\\a.txt']);
  });

  it('百分号转义会被还原（中文目录名）', () => {
    expect(parseUriList('file:///C:/%E4%B8%AD%E6%96%87/a.txt')).toEqual(['C:\\中文\\a.txt']);
  });

  it('多行 + CRLF + 注释行', () => {
    const text = '# comment\r\nfile:///C:/a.txt\r\nfile:///D:/b.txt\r\n';
    expect(parseUriList(text)).toEqual(['C:\\a.txt', 'D:\\b.txt']);
  });

  it('非 file: 的行（http 链接）整条丢掉', () => {
    expect(parseUriList('https://example.com/a.txt\nfile:///C:/b.txt')).toEqual(['C:\\b.txt']);
  });

  it('空串 / 非字符串 → 空数组', () => {
    expect(parseUriList('')).toEqual([]);
    expect(parseUriList(null)).toEqual([]);
  });
});

describe('描述文案', () => {
  it('单个文件带名字', () => {
    expect(filesDesc(1, 'a.txt')).toBe('文件 a.txt');
  });

  it('多个文件带「等 N 个」', () => {
    expect(filesDesc(3, 'a.txt')).toBe('文件 a.txt 等 3 个文件');
  });

  it('没有文件名时只报个数', () => {
    expect(filesDesc(2)).toBe('文件 2 个');
  });

  it('0 个文件回退成「文件」', () => {
    expect(filesDesc(0)).toBe('文件');
  });

  it('baseNameOf 取最后一段（正斜杠与反斜杠都认）', () => {
    expect(baseNameOf('C:\\a\\b\\c.txt')).toBe('c.txt');
    expect(baseNameOf('C:/a/b/c.txt')).toBe('c.txt');
    expect(baseNameOf('c.txt')).toBe('c.txt');
    expect(baseNameOf('')).toBe('');
  });
});
