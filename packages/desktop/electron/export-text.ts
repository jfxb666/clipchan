/**
 * 通用格式导出（v1.2 E1）：把历史导出为 Markdown / JSON / CSV 纯文本。
 *
 * ★ 与 zip 备份包（export-import.ts）的分工：zip 带**图片本体**，是完整备份；
 *   这里的文本包只带走「文本与标签」，图片条目落一行占位说明 —— 拿去给人读
 *   （贴进笔记、丢给 AI）或进表格（CSV），要图请用 zip。
 * ★ 本文件是**纯函数**模块：条目与导出时间都由调用方注入，不碰时钟 / 文件系统 /
 *   数据库，vitest（node 环境）里直接可测。读库与落盘的编排在 export-import.ts 的
 *   exportAllToTextFile（与 exportAllToZip 同款注入式风格）。
 * ★ 字段口径：TextExportItem 是 camelCase、与 ClipItemDTO 的字段命名对齐，但带
 *   **全量 content** —— ClipItemDTO 的 preview 是截断过的，不能拿来导出。
 */
import type { TextExportFormat } from '@clipchan/core';
import type { ItemRow } from './db';

/** 文本导出里的一条记录（camelCase，字段与 ClipItemDTO 命名对齐；content 是全量正文）。 */
export interface TextExportItem {
  id: string;
  kind: string;
  /** 全量正文（列表预览是截断的）；图片条目为空串。 */
  content: string;
  /** 来源应用（如 Code.exe）；未知为空 —— MD 里写「未知」，CSV 空单元格。 */
  sourceApp?: string;
  createdAt: number;
  tags?: string[];
  /** 图片尺寸（只有图片条目可能带）；未知为空。 */
  width?: number;
  height?: number;
}

/** JSON 清单里的 app 标记（与 zip 导出 EXPORT_APP 同值：两种包都认得自己人）。 */
const EXPORT_APP = 'Clipchan';
/** JSON 清单格式版本。v1 = 首版通用文本导出（与 zip 包的 version 2 各自独立计数）。 */
const TEXT_EXPORT_VERSION = 1;

/** CSV 表头（RFC 4180 顺序；tags 是分号拼接的单元格）。 */
const CSV_HEADER = 'id,kind,content,source_app,created_at,tags';

/** kind → 中文类型名（MD 标题行用）；与 organize.ts 的标签文案同口径。 */
const KIND_LABELS: Record<string, string> = {
  text: '文本',
  link: '链接',
  code: '代码',
  path: '路径',
  number: '数字',
  image: '图片',
  files: '文件',
};

/** 本地时间 → YYYY-MM-DD HH:mm:ss（手拼 padStart，与 snippetVars / export-import 同口径；仓库无日期库）。 */
function localStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

/** MD 标题里的类型名；没登记过的 kind 原样展示（新 kind 不该被吞掉）。 */
function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * 四反引号围栏包住正文。
 *
 * ★ 为什么不是三反引号：用户复制的就是代码块时（```js ... ```），三反引号围栏会被
 *   正文截断，Markdown 直接排版坏掉；四反引号只有正文里出现 ```` 才会坏，概率低得多。
 */
function fenced(content: string): string[] {
  return ['````', content, '````'];
}

/** Markdown：`# Clipchan 导出` + 每条一节（本地时间标题 + 标签行 + 正文围栏 / 图片占位）。 */
function buildMarkdown(items: TextExportItem[]): string {
  const lines: string[] = ['# Clipchan 导出'];
  for (const item of items) {
    const src = typeof item.sourceApp === 'string' && item.sourceApp.length > 0 ? item.sourceApp : '未知';
    lines.push('', '## ' + localStamp(new Date(item.createdAt)) + ' ' + kindLabel(item.kind) + '（来源: ' + src + '）');
    const tags = item.tags ?? [];
    if (tags.length > 0) lines.push('标签：' + tags.join('、'));
    if (item.kind === 'image') {
      // 图片没有正文可围：一行占位说明带 id 前 8 位与真实宽高（行上就带这两个字段）。
      const dims =
        typeof item.width === 'number' && typeof item.height === 'number'
          ? item.width + '×' + item.height
          : '尺寸未知';
      lines.push('（图片记录 ' + item.id.slice(0, 8) + '，' + dims + '，见缩略图）');
    } else {
      lines.push(...fenced(item.content));
    }
  }
  return lines.join('\n') + '\n';
}

/** RFC 4180 单元格转义：含逗号 / 引号 / 换行才加引号，内部 `"` 翻倍；普通字段不加引号。 */
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/**
 * CSV：表头 + 每条一行，行尾一律 CRLF（Excel 直接打开不串行）。
 * 图片条目 content 为空单元格；tags 用分号拼进一格（带特殊字符时整格照常转义）。
 */
function buildCsv(items: TextExportItem[]): string {
  const rows = items.map((item) =>
    [
      item.id,
      item.kind,
      item.content,
      item.sourceApp ?? '',
      String(item.createdAt),
      (item.tags ?? []).join(';'),
    ]
      .map(csvCell)
      .join(','),
  );
  return [CSV_HEADER, ...rows].map((row) => row + '\r\n').join('');
}

/** JSON：manifest 形状与 zip 包同款（app / version / exportedAt / items），字段全量不丢。 */
function buildJson(items: TextExportItem[], exportedAt: string): string {
  const manifest = { app: EXPORT_APP, version: TEXT_EXPORT_VERSION, exportedAt, items };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * 把条目列表渲染成一种通用文本格式。
 *
 * ★ 纯函数：items / exportedAt 全部由调用方注入（exportAllToTextFile 传
 *   `new Date(now).toISOString()`），这里不取当前时间，测试不需要 fake 时钟。
 *
 * @param items      全量正文的条目（图片条目 content 为空串）
 * @param format     目标格式
 * @param exportedAt ISO 导出时间戳（只有 JSON 用它；md/csv 不带导出时刻）
 */
export function buildTextExport(items: TextExportItem[], format: TextExportFormat, exportedAt: string): string {
  if (format === 'json') return buildJson(items, exportedAt);
  if (format === 'csv') return buildCsv(items);
  return buildMarkdown(items);
}

/** 默认文件名 clipchan-export-YYYYMMDD-HHmmss.<ext>（本地时间，与 zip 导出同一时间戳口径，只换扩展名）。 */
export function textExportFileName(d: Date, format: TextExportFormat): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return 'clipchan-export-' + stamp + '.' + format;
}

/**
 * 宽容解析 tags JSON 列：坏 JSON / 非数组 / 非字符串（含空串）一律当没标签，绝不抛。
 * 与 db.ts 私有的 parseTags 同口径 —— 一条脏标签不该让整次导出失败。
 */
function tagsFromJson(v: string | null | undefined): string[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/**
 * 数据库行 → 文本导出条目。
 *
 * ★ content null（图片列）归空串；source_app / width / height 的 null 归 undefined
 *   （TextExportItem 用「没有」而不是「null」表达未知，MD/CSV 的兜底文案在 builder 里统一处理）。
 * ★ tags 从 JSON 列宽容解析：坏数据当没标签，绝不让一条脏行炸掉整次导出。
 */
export function textExportItemsFromRows(rows: ItemRow[]): TextExportItem[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    content: row.content ?? '',
    sourceApp: row.source_app ?? undefined,
    createdAt: row.created_at,
    tags: tagsFromJson(row.tags),
    width: row.width ?? undefined,
    height: row.height ?? undefined,
  }));
}
