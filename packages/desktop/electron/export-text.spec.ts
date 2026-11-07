/**
 * 通用格式导出（v1.2 E1）单测。
 *
 * ★ buildTextExport 是纯函数：条目与导出时间都由调用方注入，这里不碰时钟/文件系统，
 *   与 export-import.spec 测 exportAllToZip 的注入式风格同款。
 * ★ 条目替身按 TextExportItem 的形状来（camelCase，与 ClipItemDTO 字段命名对齐；
 *   但带全量 content —— ClipItemDTO 的 preview 是截断过的，不能拿它导出）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildTextExport,
  textExportFileName,
  textExportItemsFromRows,
  type TextExportItem,
} from './export-text';
import type { ItemRow } from './db';

const items = [
  {
    id: 'a',
    kind: 'text',
    content: '第一行\r\n第二行',
    sourceApp: 'weixin.exe',
    createdAt: new Date(2026, 0, 1, 12, 0, 0).getTime(),
    tags: ['链接'],
    folderId: null,
  },
  {
    id: 'b',
    kind: 'image',
    content: '',
    sourceApp: 'snip.exe',
    createdAt: 1700000060000,
    tags: [],
    folderId: null,
  },
] as never as TextExportItem[];

describe('通用格式导出（v1.2 E1）', () => {
  it('★ JSON：manifest 形状完整、字段不丢', () => {
    const j = JSON.parse(buildTextExport(items, 'json', '2026-11-06T00:00:00Z')) as {
      app: string;
      version: number;
      exportedAt: string;
      items: { id: string; tags?: string[]; content: string; sourceApp?: string }[];
    };
    expect(j.app).toBe('Clipchan');
    expect(j.version).toBe(1);
    expect(j.exportedAt).toBe('2026-11-06T00:00:00Z');
    expect(j.items).toHaveLength(2);
    expect(j.items[0]!.tags).toEqual(['链接']);
    expect(j.items[0]!.content).toBe('第一行\r\n第二行');
    expect(j.items[0]!.sourceApp).toBe('weixin.exe');
  });
  it('★ CSV：含逗号/换行/引号的字段正确转义', () => {
    const csv = buildTextExport(items, 'csv', 'x');
    expect(csv.split(/\r?\n/)[0]).toBe('id,kind,content,source_app,created_at,tags');
    expect(csv).toContain('"第一行\r\n第二行"'); // 换行进引号字段
    // 内部引号翻倍（RFC 4180）；无特殊字符的字段不加引号
    const quoted = buildTextExport(
      [{ id: 'c', kind: 'text', content: '他说："你好"', sourceApp: 'a.exe', createdAt: 1, tags: ['x'] }],
      'csv',
      'x',
    );
    expect(quoted).toContain('"他说：""你好"""');
    expect(quoted).toContain(',a.exe,');
    // 标签分号拼接进单元格
    const tagged = buildTextExport(
      [{ id: 'd', kind: 'text', content: 'n', sourceApp: 'a.exe', createdAt: 1, tags: ['a', 'b'] }],
      'csv',
      'x',
    );
    expect(tagged).toContain(',a;b\r\n');
  });
  it('★ Markdown：图片条目有占位说明，代码围栏用四反引号防内容破坏', () => {
    const md = buildTextExport(items, 'md', 'x');
    expect(md).toContain('## 2026-01-01');
    expect(md).toContain('（图片记录');
    expect(md).toContain('````');
    // 四反引号围栏包住含三反引号的正文，不会被内容截断
    const code = buildTextExport(
      [{ id: 'e', kind: 'code', content: '```js\nconsole.log(1)\n```', sourceApp: 'vscode.exe', createdAt: 1 }],
      'md',
      'x',
    );
    expect(code).toContain('````\n```js\nconsole.log(1)\n```\n````');
  });
  it('Markdown：标题带本地时间/类型/来源，正文在围栏内，图片占位带真实宽高', () => {
    const md = buildTextExport(
      [
        { id: 'abcdef1234', kind: 'image', content: '', sourceApp: 'snip.exe', createdAt: 1, width: 1920, height: 1080 },
        { id: 'f', kind: 'text', content: '正文', sourceApp: 'weixin.exe', createdAt: new Date(2026, 0, 1, 9, 5, 3).getTime(), tags: ['工作', '待办'] },
      ],
      'md',
      'x',
    );
    expect(md).toContain('# Clipchan 导出');
    expect(md).toContain('## 2026-01-01 09:05:03 文本（来源: weixin.exe）');
    expect(md).toContain('标签：工作、待办');
    // 图片：id 前 8 位 + 真实 width×height（DTO/行上就带这两个字段）
    expect(md).toContain('（图片记录 abcdef12，1920×1080，见缩略图）');
    expect(md).not.toContain('````\n\n````'); // 图片条目不用围栏包空内容
  });
  it('Markdown：来源未知写「未知」，图片无宽高写「尺寸未知」', () => {
    const md = buildTextExport(
      [{ id: 'xyz', kind: 'image', content: '', createdAt: 1 }],
      'md',
      'x',
    );
    expect(md).toContain('（来源: 未知）');
    expect(md).toContain('尺寸未知');
  });
  it('空列表导出合法空文档（三种格式都不抛）', () => {
    for (const f of ['md', 'json', 'csv'] as const) {
      expect(() => buildTextExport([], f, 'x')).not.toThrow();
    }
    expect(buildTextExport([], 'csv', 'x').split(/\r?\n/)[0]).toBe('id,kind,content,source_app,created_at,tags');
    expect(JSON.parse(buildTextExport([], 'json', 'x'))).toMatchObject({ app: 'Clipchan', items: [] });
  });
  it('CSV 每行以 CRLF 结尾（Excel 直接打开不串行）', () => {
    const csv = buildTextExport(items, 'csv', 'x');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.includes('\n')).toBe(true);
  });
});

describe('行替身 → 导出条目（textExportItemsFromRows）', () => {
  it('tags JSON 列宽容解析；content null（图片）归空串；宽高带出', () => {
    const rows = [
      {
        id: 'r1',
        kind: 'text',
        content: '正文',
        source_app: 'a.exe',
        created_at: 123,
        tags: '["代码","JSON"]',
        width: null,
        height: null,
      },
      {
        id: 'r2',
        kind: 'image',
        content: null,
        source_app: null,
        created_at: 456,
        tags: null,
        width: 800,
        height: 600,
      },
      {
        id: 'r3',
        kind: 'text',
        content: '坏标签',
        source_app: 'a.exe',
        created_at: 789,
        tags: 'not-json[',
        width: null,
        height: null,
      },
    ] as never as ItemRow[];
    const out = textExportItemsFromRows(rows);
    expect(out[0]).toEqual({
      id: 'r1', kind: 'text', content: '正文', sourceApp: 'a.exe', createdAt: 123,
      tags: ['代码', 'JSON'], width: undefined, height: undefined,
    });
    expect(out[1]).toEqual({
      id: 'r2', kind: 'image', content: '', sourceApp: undefined, createdAt: 456,
      tags: [], width: 800, height: 600,
    });
    // 坏 JSON 标签一律当没标签，绝不抛（与 db.ts parseTags 同口径）
    expect(out[2]!.tags).toEqual([]);
  });
});

describe('默认文件名（textExportFileName）', () => {
  it('与 zip 导出同一时间戳口径，只换扩展名', () => {
    expect(textExportFileName(new Date(2026, 0, 1, 9, 5, 3), 'md')).toBe('clipchan-export-20260101-090503.md');
    expect(textExportFileName(new Date(2026, 0, 1, 9, 5, 3), 'json')).toBe('clipchan-export-20260101-090503.json');
    expect(textExportFileName(new Date(2026, 0, 1, 9, 5, 3), 'csv')).toBe('clipchan-export-20260101-090503.csv');
  });
});
