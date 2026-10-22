/**
 * 文件列表读取与签名（P0-1）。
 *
 * 全程喂字节 / 喂文本，不碰剪贴板也不 import electron：
 * 这一层出错的后果是"复制文件记成一条纯文本"，只有纯函数级断言能钉住。
 */
import { describe, expect, it } from 'vitest';
import { buildDropFiles } from './dropfiles';
import { MAX_FILES } from './dropfiles';
import { describeFiles, filePathsSignature, readFilePaths } from './files';

describe('readFilePaths', () => {
  it('★ helperPaths 优先于其它两条通道（唯一可靠的 CF_HDROP 来源）', () => {
    const paths = readFilePaths({
      formats: ['text/uri-list'],
      fileNameW: buildDropFiles(['C:\\a\\from-bytes.txt']),
      uriList: 'file:///C:/a/from-uri.txt',
      helperPaths: ['C:\\a\\from-helper.txt'],
    });
    expect(paths).toEqual(['C:\\a\\from-helper.txt']);
  });

  it('helperPaths 为 null / 空数组 → 退回字节通道', () => {
    const fileNameW = buildDropFiles(['C:\\a\\one.txt']);
    for (const helperPaths of [null, undefined, []]) {
      expect(readFilePaths({ formats: ['text/uri-list'], fileNameW, helperPaths })).toEqual([
        'C:\\a\\one.txt',
      ]);
    }
  });

  it('helperPaths 里的相对路径 / 重复项同样被清理', () => {
    const paths = readFilePaths({
      formats: ['text/uri-list'],
      helperPaths: ['C:\\a\\1.txt', 'relative.txt', 'c:\\A\\1.txt', '   '],
    });
    expect(paths).toEqual(['C:\\a\\1.txt']);
  });

  it('FileNameW（DROPFILES）优先于 uriList', () => {
    const fileNameW = buildDropFiles(['C:\\a\\one.txt']);
    const paths = readFilePaths({
      formats: ['text/uri-list'],
      fileNameW,
      uriList: 'file:///C:/a/two.txt',
    });
    expect(paths).toEqual(['C:\\a\\one.txt']);
  });

  it('FileNameW 解不出来时退回 uriList', () => {
    const paths = readFilePaths({
      formats: ['text/uri-list'],
      fileNameW: Buffer.alloc(0),
      uriList: 'file:///C:/a/two.txt\r\nfile:///C:/a/three.txt',
    });
    expect(paths).toEqual(['C:\\a\\two.txt', 'C:\\a\\three.txt']);
  });

  it('两者都空 → 空数组', () => {
    expect(readFilePaths({ formats: [] })).toEqual([]);
    expect(readFilePaths({ formats: ['text/uri-list'], fileNameW: null, uriList: null })).toEqual([]);
    expect(readFilePaths({ formats: ['text/uri-list'], fileNameW: Buffer.alloc(0), uriList: '' })).toEqual([]);
  });

  it('去重且不区分大小写（Windows 路径）', () => {
    const paths = readFilePaths({
      formats: ['text/uri-list'],
      uriList: 'file:///C:/A/One.txt\r\nfile:///c:/a/one.txt\r\nfile:///C:/A/two.txt',
    });
    expect(paths).toEqual(['C:\\A\\One.txt', 'C:\\A\\two.txt']);
  });

  it('相对路径被丢掉，只留绝对路径', () => {
    const paths = readFilePaths({
      formats: ['text/uri-list'],
      uriList: ['file:relative.txt', 'file:///C:/abs/ok.txt', 'not-a-uri-at-all'].join('\r\n'),
    });
    expect(paths).toEqual(['C:\\abs\\ok.txt']);
  });

  it('UNC 路径（\\\\server\\share）算绝对路径，保留', () => {
    const paths = readFilePaths({
      formats: ['FileNameW'],
      fileNameW: buildDropFiles(['\\\\server\\share\\x.txt']),
    });
    expect(paths).toEqual(['\\\\server\\share\\x.txt']);
  });

  it('超过 MAX_FILES 截断', () => {
    const many: string[] = [];
    for (let i = 0; i < MAX_FILES + 20; i++) many.push('file:///C:/bulk/f' + i + '.txt');
    const paths = readFilePaths({ formats: ['text/uri-list'], uriList: many.join('\r\n') });
    expect(paths).toHaveLength(MAX_FILES);
    expect(paths[0]).toBe('C:\\bulk\\f0.txt');
    expect(paths[MAX_FILES - 1]).toBe('C:\\bulk\\f' + (MAX_FILES - 1) + '.txt');
  });
});

describe('filePathsSignature', () => {
  it('同一列表摘要相同，且带 files: 前缀', () => {
    const a = ['C:\\a\\1.txt', 'C:\\a\\2.txt'];
    const sig = filePathsSignature(a);
    expect(sig).toBe(filePathsSignature(['C:\\a\\1.txt', 'C:\\a\\2.txt']));
    expect(sig.startsWith('files:')).toBe(true);
  });

  it('大小写不同视为同一批（Windows 路径不区分大小写）', () => {
    expect(filePathsSignature(['C:\\A\\1.txt'])).toBe(filePathsSignature(['c:\\a\\1.txt']));
  });

  it('顺序不同 → 摘要不同（重新复制的一批就是新的一条）', () => {
    expect(filePathsSignature(['C:\\a\\1.txt', 'C:\\a\\2.txt'])).not.toBe(
      filePathsSignature(['C:\\a\\2.txt', 'C:\\a\\1.txt']),
    );
  });

  it('空数组 → 空串', () => {
    expect(filePathsSignature([])).toBe('');
  });
});

describe('describeFiles', () => {
  it('单个文件 → 带文件名', () => {
    expect(describeFiles(['C:\\a\\报告.docx'])).toBe('文件 报告.docx');
  });

  it('多个文件 → 首文件名 + 等 N 个文件', () => {
    expect(describeFiles(['C:\\a\\报告.docx', 'C:\\a\\b.txt'])).toBe('文件 报告.docx 等 2 个文件');
  });

  it('空列表 → 只说"文件"', () => {
    expect(describeFiles([])).toBe('文件');
  });
});
