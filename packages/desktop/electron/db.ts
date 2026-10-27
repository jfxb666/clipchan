/**
 * SQLite 存储层。
 *
 * 表结构逐字对齐 spec §9.2（items 表 + 两个 partial unique index + idx_order）。
 * 设置存 settings 表（key/value，value 为 JSON），**不写任何 settings.json**（spec §9.4）。
 *
 * 设计要点：
 * - 排序键固定为 `pinned DESC, created_at DESC, seq DESC`（spec §7.4 / Global Constraints）。
 * - `seq` 单调递增，由 `items` 表自增列（AUTOINCREMENT）派生；这样同一毫秒插入的
 *   多条记录也能有确定的先后。
 * - 去重扫**整段历史**：命中已有 content_hash / image_hash 时 UPDATE 并**同时**刷新
 *   `created_at` 与 `seq`（只刷一个都会出 bug）。
 * - 单条文本上限 100000 字符，超限截断并置 truncated。
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  DEFAULT_SETTINGS,
  canMoveFolder,
  classify,
  matchSearch,
  previewOfImage,
  previewOfText,
  sanitizeTag,
  type ClipItemDTO,
  type FolderDTO,
  type FolderInput,
  type Kind,
  type KindFilter,
  type ListQuery,
  type OptimizeHistoryEntry,
  type OrganizeFolder,
  type SearchNode,
  type Settings,
  type Snippet,
  type SnippetInput,
  type TagCountDTO,
  type UrlPreviewDTO,
} from '@clipchan/core';
import { pinyin } from 'pinyin-pro';
import { baseNameOf, filesDesc } from './dropfiles';

/** 单条文本字符上限（抄 legacy/src/Store.cs:15 MaxChars）。 */
export const TEXT_LIMIT = 100000;

/** 列表默认每页条数 / 上限（spec §8.1）。 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** 优化历史的保留条数（计划 Ruling 6：上限 100 条，超出淘汰最旧）。 */
export const OPTIMIZE_HISTORY_LIMIT = 100;

/** 库里的来源标记（spec §9.2 用的是 'clip'，core 的 DTO 用的是 'capture'）。 */
type DbSource = 'clip' | 'merge';

/**
 * 两个唯一索引的 DDL。
 *
 * ★ 谓词必须带 `deleted_at IS NULL`：回收站里的行不该再占住哈希。两处必须同时改——
 *   去重 SELECT 加了条件而索引没改 → 同内容再复制撞 UNIQUE；索引改了而 SELECT 没改 →
 *   刷新一条已删记录的排序，用户复制完列表里什么都不出现。
 *   抽成常量是因为迁移要 drop 后按**同一段文本**重建（SQLite 不支持 ALTER INDEX）。
 */
const UNIQUE_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_hash ON items(content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_hash   ON items(image_hash)   WHERE image_hash   IS NOT NULL AND deleted_at IS NULL;`;

/**
 * v0.5.0 新增的 optimize_history 表 DDL。
 *
 * ★ 抽成常量而不是在 SCHEMA_SQL 与迁移里各抄一份：两处必须逐字一致，
 *   抄两份的唯一结果就是某天只改了一处（老库升级后没有表，全新库有）。
 */
const OPTIMIZE_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS optimize_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  output      TEXT NOT NULL,
  scene_id    TEXT NOT NULL,
  mode        TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opt_hist ON optimize_history(created_at DESC, id DESC);`;

/** 片段库上限：超出淘汰 updated_at 最旧的（片段是用户手存的，比历史更值得留，所以上限高）。 */
export const SNIPPET_LIMIT = 200;

/**
 * v0.6.0 片段库 DDL。
 *
 * ★ 与 OPTIMIZE_HISTORY_SQL 同理抽成常量：SCHEMA_SQL 与迁移必须逐字一致，
 *   否则老库升级后没有这张表，而全新库有。
 */
const SNIPPET_SQL = `
CREATE TABLE IF NOT EXISTS snippets (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  use_count  INTEGER NOT NULL DEFAULT 0
);`;

/**
 * v1.0.0 ⑥ 智能整理的 folders 表 DDL。
 *
 * ★ 与 OPTIMIZE_HISTORY_SQL / SNIPPET_SQL 同一范式：SCHEMA_SQL 与迁移必须逐字一致，
 *   否则老库升级后没有这张表，而全新库有。
 * ★ 这里**不建外键**：items.folder_id 与 folders.parent_id 的完整性由 db 层自己保证
 *   （删文件夹时先把记录放回未归类），外键的 ON DELETE 语义在这里一个都不合用——
 *   级联删会把用户辛苦建的记录带走。
 */
const FOLDER_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);`;

/**
 * v1.1.0 URL 预览缓存表 DDL。
 *
 * ★ 与 OPTIMIZE_HISTORY_SQL / SNIPPET_SQL / FOLDER_SQL 同一范式：SCHEMA_SQL 与迁移
 *   必须逐字一致，否则老库升级后没有这张表，而全新库有。
 * ★ 这是**纯缓存**：内容随时可以从网络上重新抓一次，因此没有迁移逻辑、不建额外索引
 *   （主键 url 就是唯一查询入口），清空重建也不会有任何数据损失。
 */
const URL_PREVIEW_SQL = `
CREATE TABLE IF NOT EXISTS url_previews (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL
);`;

/** 写一条 URL 预览缓存的入参（iconUrl ↔ 列 icon_url 在读写处映射）。 */
export interface UrlPreviewInput {
  url: string;
  title: string;
  domain: string;
  iconUrl: string;
  fetchedAt: number;
}

/**
 * 建表 SQL —— ★ 逐字抄 spec §9.2，不要"顺手优化"。
 *
 * ★ 这里**故意不建两个唯一索引**：它们的谓词引用 `deleted_at`，而 v0.2.0 的老库要等
 *   ensureColumns 补完列才有这一列。把索引 DDL 放在建表段里，老库就会在
 *   "索引恰好缺失 + 列也缺失"时抛 `no such column: deleted_at` 直接起不来
 *   （`IF NOT EXISTS` 只在索引已存在时静默跳过，索引不存在时照样校验谓词）。
 *   索引统一由 migrateTrashSchema 在建列之后创建，全新库同样一步到位。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  content      TEXT,
  content_hash TEXT,
  image_path   TEXT,
  image_hash   TEXT,
  thumb_path   TEXT,
  width        INTEGER, height INTEGER, bytes INTEGER,
  source       TEXT NOT NULL DEFAULT 'clip',
  pinned       INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  deleted_at   INTEGER,
  source_app   TEXT,
  file_paths   TEXT,
  rich_html    TEXT,
  search_index TEXT,
  tags         TEXT,
  folder_id    TEXT,
  phash        TEXT
);
CREATE INDEX IF NOT EXISTS idx_order ON items(pinned DESC, created_at DESC, seq DESC);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
${OPTIMIZE_HISTORY_SQL}
${SNIPPET_SQL}
${FOLDER_SQL}
${URL_PREVIEW_SQL}
`;

/** items 表的一行（只列出我们真正读的列）。 */
export interface ItemRow {
  id: string;
  kind: string;
  content: string | null;
  content_hash: string | null;
  image_path: string | null;
  image_hash: string | null;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  source: string;
  pinned: number;
  truncated: number;
  created_at: number;
  seq: number;
  /** 进回收站的时间戳；活跃行为 null。 */
  deleted_at: number | null;
  /** 来源 exe 名（如 Code.exe）；未知为 null —— 不写任何兜底串。 */
  source_app: string | null;
  /** 文件记录的绝对路径 JSON 数组（v0.6.0）；非文件记录为 null。绝不出主进程。 */
  file_paths: string | null;
  /** 富文本原样 text/html（v0.6.0）；纯文本行为 null。 */
  rich_html: string | null;
  /** 自建的拼音/小写检索列（v0.6.0）；由 buildSearchIndex 在 Node 里算好再写。 */
  search_index: string | null;
  /**
   * v1.0.0 ⑥ 标签：JSON 字符串数组（如 ["代码","JSON"]）；无标签为 null。
   * ★ 标成可选是为了不逼调用方（含既有单测的行替身）跟着改：SELECT * 出来的行
   *   在 ensureColumns 之后一定有这两列，实际运行时永远拿得到值。
   */
  tags?: string | null;
  /** v1.0.0 ⑥ 所属文件夹 id；未归类为 null。理由同上。 */
  folder_id?: string | null;
  /**
   * v1.1.0 图片感知哈希（64 位十六进制串）；非图片行与老行为 null。理由同上——可选，
   * 是为了不逼既有单测的行替身跟着改。
   */
  phash?: string | null;
}

/** snippets 表的一行。 */
export interface SnippetRow {
  id: string;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
  use_count: number;
}

/** optimize_history 表的一行（id 在库里是 INTEGER AUTOINCREMENT）。 */
interface OptimizeHistoryRow {
  id: number;
  source: string;
  output: string;
  scene_id: string;
  mode: string;
  provider_id: string;
  provider_name: string;
  created_at: number;
}

/** 图片记录在库里的那几列（Task 6 的 getFullImage、Task 8 的清理都用它）。 */
export interface ImageRow {
  id: string;
  /** 图片行的 content 恒为 NULL（spec §9.2）。 */
  content: string | null;
  image_path: string | null;
  thumb_path: string | null;
  image_hash: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  created_at: number;
  seq: number;
  pinned: boolean;
  truncated: boolean;
  source: 'capture' | 'merge';
  /** 回收站时间戳；预算淘汰要按「回收站行优先」排序，所以必须带出去。 */
  deleted_at: number | null;
}

/** insertText 的可选参数。 */
export interface InsertTextOpts {
  kind?: Exclude<Kind, 'image'>;
  pinned?: boolean;
  /** 已截断标记（迁移时从旧文件的 trunc 键读入）。 */
  truncated?: boolean;
  /** 指定创建时间（迁移用）；缺省取当前时间。 */
  createdAt?: number;
  /** createdAt 的别名（测试 / 调用方更顺手的写法）。 */
  now?: number;
  /** 指定序号（迁移用）；缺省取下一个自增序号。 */
  seq?: number;
  source?: 'capture' | 'merge';
  /** 来源 exe 名；未知就不传（不落兜底串）。去重命中时不覆盖已有来源。 */
  sourceApp?: string;
  /** 剪贴板里的 text/html 原样（v0.6.0）；纯文本不传。 */
  richHtml?: string;
}

/** insertFiles 的可选参数（形状与 InsertImageOpts 对齐）。 */
export interface InsertFilesOpts {
  pinned?: boolean;
  createdAt?: number;
  /** createdAt 的别名（测试 / 调用方更顺手的写法）。 */
  now?: number;
  seq?: number;
  source?: 'capture' | 'merge';
  /** 来源 exe 名；未知就不传。 */
  sourceApp?: string;
}

/** insertImage 的元数据。 */
export interface ImageMeta {
  hash: string;
  width: number;
  height: number;
  bytes: number;
  /** 相对数据目录的相对路径，如 images/<id>.jpg */
  imagePath: string;
  /** 相对数据目录的相对路径，如 thumbs/<id>.png */
  thumbPath: string;
  pinned?: boolean;
  createdAt?: number;
  seq?: number;
  source?: 'capture' | 'merge';
  /**
   * v1.1.0 图片感知哈希（64 位十六进制串）：只用于"库里是否已有相近图片"的判定，
   * 与去重用的 hash（sha256）是两回事。算不出来就不传，此时整段相似判定跳过。
   */
  phash?: string;
}

export interface InsertImageOpts {
  pinned?: boolean;
  createdAt?: number;
  /** createdAt 的别名。 */
  now?: number;
  seq?: number;
  source?: 'capture' | 'merge';
  /** 来源 exe 名；未知就不传。 */
  sourceApp?: string;
}

/** 插入/去重命中后的返回值。touched=true 表示命中了已有条目（被提到最前）。 */
export interface InsertResult {
  id: string;
  touched: boolean;
  /**
   * v1.1.0：库里已有一条**视觉相近**的图片时，那条记录的 id。
   * ★ 相似不等于相同：记录照样入库（id 是这次新建的），这里只是让调用方能提示一句。
   *   完全相同的图走上面的 touched 分支，此时不填这个字段。
   */
  similarTo?: string;
}

export interface Db {
  /** 底层句柄（测试与上层诊断用）。 */
  readonly raw: Database.Database;
  insertText(text: string, opts?: InsertTextOpts): InsertResult;
  insertImage(meta: ImageMeta, opts?: InsertImageOpts): InsertResult;
  /** 记录一条"复制的文件"（v0.6.0）；空数组不落库，直接回 { id: '', touched: false }。 */
  insertFiles(paths: string[], opts?: InsertFilesOpts): InsertResult;
  /** 读文件记录的路径列表；坏数据 / 行不存在一律回 []，绝不抛。 */
  getFilePaths(id: string): string[];
  /** 读富文本原样；没有就回 null。 */
  getRichHtml(id: string): string | null;
  list(q?: ListQuery): ClipItemDTO[];
  /** 与 list 同条件的总条数（分页时界面显示"共 N 条"）。 */
  count(q?: ListQuery): number;
  remove(id: string): ItemRow | null;
  removeMany(ids: string[]): ItemRow[];
  togglePin(id: string): boolean;
  /** 批量置位/取消收藏，只影响活跃行；返回实际改动条数。 */
  pinMany(ids: string[], pinned: boolean): number;
  clearUnpinned(): ItemRow[];
  clearAll(): number;
  /** 回收站列表（按删除时间倒序）。谓词与 buildWhere 相反，所以不复用它。 */
  listTrash(q?: { limit?: number; offset?: number }): ClipItemDTO[];
  countTrash(): number;
  /** 从回收站恢复一条：created_at 与 seq 原样保留，记录回到原本的时间位置。 */
  restore(id: string): boolean;
  restoreMany(ids: string[]): number;
  /** 硬删指定行，返回实际删除条数。调用方负责先取图片相对路径再删文件。 */
  purge(ids: string[]): number;
  /** 硬删超出 trashLimit 的最旧回收站行，返回被删 id（供调用方删盘）。 */
  purgeTrashOverLimit(): string[];
  getSettings(): Settings;
  setSettings(patch: Partial<Settings>): Settings;
  /**
   * 读任意 settings 键（绕过 sanitizeSettings 白名单）。
   * AI provider 元数据与 Key 用：这些键不在 Settings 里，也不进 settingsCache。
   */
  getSettingValue<T = unknown>(key: string): T | undefined;
  /** 写任意 settings 键；**不**写 settingsCache，所以 getSettings() 永远看不到它。 */
  setSettingValue(key: string, value: unknown): void;
  getRow(id: string): ItemRow | null;
  /**
   * 读一条记录的正文全文（列表预览是截断的，优化面板要原文）。
   * 图片行 content 为 NULL、id 不存在 → 一律返回 ''，不抛。
   */
  getText(id: string): string;
  /** 写一条优化历史；写完立刻把超出 OPTIMIZE_HISTORY_LIMIT 的最旧行硬删。 */
  addOptimizeHistory(e: Omit<OptimizeHistoryEntry, 'id'>): OptimizeHistoryEntry;
  /** 按 created_at DESC, id DESC 取（最新在前）；limit 缺省取全部（最多也就 100 条）。 */
  listOptimizeHistory(limit?: number): OptimizeHistoryEntry[];
  removeOptimizeHistory(id: string): boolean;
  /** 清空并返回实际删除条数。 */
  clearOptimizeHistory(): number;
  getImageRow(id: string): ImageRow | null;
  /** 全部图片行；unpinnedOnly=true 时只要未收藏的（清空未收藏 / 预算淘汰用）。 */
  allImageRows(opts?: { unpinnedOnly?: boolean }): ImageRow[];
  touch(id: string): void;
  /** 片段库：按 updated_at DESC, id DESC（最近改过的在前）。 */
  listSnippets(): Snippet[];
  /** 新增或更新一条片段，写完按 SNIPPET_LIMIT 淘汰最旧，返回更新后的全表。 */
  saveSnippet(input: SnippetInput): Snippet[];
  removeSnippet(id: string): Snippet[];
  /** 用一次：use_count + 1，**不动** updated_at（用一次不算编辑）。 */
  touchSnippet(id: string): Snippet[];
  getSnippet(id: string): Snippet | null;
  /**
   * v1.0.0 ⑥ 整理文件夹的平表（树由渲染层用 core 的 buildFolderTree 现场拼）。
   * ★ 五个写操作一律返回**变更后的完整平表**（与 snippets 同一范式）：界面据此重建树，
   *   不必再拉一次；非法操作返回原表不变，绝不抛——它们都来自用户的拖拽/改名，
   *   一次误拖不该炸掉整条 IPC 调用。
   */
  listFolders(): FolderDTO[];
  createFolder(input: FolderInput): FolderDTO[];
  renameFolder(id: string, name: string): FolderDTO[];
  /** 改父级；parentId=null 表示提升为顶层。成环 / 超深 / 目标不存在 → 原表不变。 */
  moveFolder(id: string, parentId: string | null): FolderDTO[];
  /** 删文件夹：里面的记录回到未归类（记录不删），子文件夹提升为顶层。 */
  removeFolder(id: string): FolderDTO[];
  /** 整体替换一条记录的标签（内部会 sanitize）；id 不存在时静默无操作。 */
  setTags(id: string, tags: string[]): void;
  /** 把一条记录放进文件夹（folderId=null 表示移出到未归类）；id 不存在时静默无操作。 */
  setFolder(id: string, folderId: string | null): void;
  /** 读一条记录的标签；无标签 / id 不存在 / 坏数据 → []。 */
  getTags(id: string): string[];
  /** 活跃记录的标签统计（count 降序、tag 升序）；空库返回 []。 */
  listTags(): TagCountDTO[];
  /**
   * v1.1.0 写一条 URL 预览缓存（同 url 覆盖）。
   * url 为空串时直接返回、不落行：没有 url 的缓存行谁也查不到，只会白占地方。
   */
  upsertUrlPreview(p: UrlPreviewInput): void;
  /**
   * v1.1.0 批量读 URL 预览缓存。入参为空数组时返回 []；
   * 只返回库里**确实存在**的记录（未命中的 url 不占位、不返回 undefined 项）。
   */
  getUrlPreviews(urls: string[]): UrlPreviewDTO[];
  close(): void;
}

// ---------------- 工具 ----------------

/** 文本的 sha256（去重键）。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 图片字节的 sha256（去重键）。 */
export function hashBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 两个感知哈希的汉明距离：逐位比较不同的字符个数。
 *
 * ★ 感知哈希是**十六进制串**（64 位 = 16 个 hex 字符），所以"位"在这里就是"字符"：
 *   一个 hex 字符差 1 位也差 4 位都算 1，这是 dHash 的通行近似（与 pHash 库一致）。
 * ★ 不等长一律回 999（"差得远"）：宁可判成不相似，也不让一次格式不一致的哈希
 *   把两条无关的图片判成相近。
 */
export function hammingDistance(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') return 999;
  if (a.length === 0 || a.length !== b.length) return 999;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) diff += 1;
  }
  return diff;
}

/**
 * 判定"视觉相近"的汉明距离阈值。
 *
 * ★ 64 位哈希下差 10 位 ≈ 视觉上很接近（缩放 / 轻微重压缩 / 换一个截图边框）。
 *   调小会漏判（同一张图重新截图判不出来），调大会误判（同色系的截图被判成一张）。
 */
export const SIMILAR_HAMMING_THRESHOLD = 10;

/**
 * 生成检索列：原文 + 全拼 + 首字母，统一小写。
 *
 * ★ 为什么不用 FTS5 trigram：实测 SQLite 3.53 的 trigram 分词要求查询串 ≥3 字符，
 *   中文两字词（"验收"）永远不命中——而那正是中文用户最常输入的搜索长度。
 *   所以走"自建一列 + LIKE"，代价是写入时多算一次，读时全表扫（历史几千条量级可接受）。
 *
 * ★ pinyin 抛错时只回原文小写：检索列算不出来不该让整条记录写不进库。
 */
export function buildSearchIndex(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  try {
    const full = pinyin(text, { toneType: 'none', type: 'array' }).join('');
    const initials = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join('');
    return (text + ' ' + full + ' ' + initials).toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function nextSeqOf(raw: Database.Database): number {
  return (raw.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM items').get() as { m: number }).m + 1;
}

function sourceToDb(s: 'capture' | 'merge' | undefined): DbSource {
  return s === 'merge' ? 'merge' : 'clip';
}

/** 来源 exe 名归一：空/非字符串一律 null —— 库里不存兜底串，缺来源就是"没有"。 */
function sourceAppToDb(v: string | undefined): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sourceToDto(s: string): 'capture' | 'merge' {
  return s === 'merge' ? 'merge' : 'capture';
}

function toKind(v: string): Kind {
  switch (v) {
    case 'text': case 'link': case 'code': case 'path': case 'number': case 'image': case 'files':
      return v;
    default:
      return 'text';
  }
}

function kbLabel(bytes: number): string {
  return Math.floor(bytes / 1024) + ' KB';
}

/**
 * 行 → 给界面看的投影。原图磁盘路径与哈希不出主进程（spec §8.1）。
 * 回收站字段按"有才给"的写法投影：NULL 就是 undefined，绝不编一个兜底串出来。
 */
function rowToDto(row: ItemRow): ClipItemDTO {
  const kind = toKind(row.kind);
  const pinned = row.pinned === 1;
  const source = sourceToDto(row.source);
  const extra: Pick<ClipItemDTO, 'sourceApp' | 'deletedAt' | 'hasRich' | 'tags' | 'folderId'> = {};
  if (row.source_app) extra.sourceApp = row.source_app;
  if (typeof row.deleted_at === 'number') extra.deletedAt = row.deleted_at;
  if (typeof row.rich_html === 'string' && row.rich_html.length > 0) extra.hasRich = true;
  // v1.0.0 ⑥：同样"有才给"——空标签列表不回空数组，省 IPC 载荷也让界面能一眼判断"没标签"。
  const tags = parseTags(row.tags);
  if (tags.length > 0) extra.tags = tags;
  if (typeof row.folder_id === 'string' && row.folder_id.length > 0) extra.folderId = row.folder_id;
  if (kind === 'image') {
    const w = row.width ?? 0;
    const h = row.height ?? 0;
    const bytes = row.bytes ?? 0;
    const dims: Pick<ClipItemDTO, 'width' | 'height'> = w > 0 && h > 0 ? { width: w, height: h } : {};
    return {
      id: row.id,
      kind,
      preview: previewOfImage(w, h, bytes),
      thumbUrl: row.thumb_path ?? undefined,
      createdAt: row.created_at,
      pinned,
      sizeLabel: kbLabel(bytes),
      source,
      ...dims,
      ...extra,
    };
  }
  const textExtra: Pick<ClipItemDTO, 'fileCount'> = kind === 'files'
    ? { fileCount: parseFilePaths(row.file_paths).length }
    : {};
  return {
    id: row.id,
    kind,
    preview: previewOfText(row.content ?? ''),
    createdAt: row.created_at,
    pinned,
    truncated: row.truncated === 1,
    source,
    ...textExtra,
    ...extra,
  };
}

/**
 * optimize_history 行 → DTO。
 * ★ id 出库必须是 string：库里是 INTEGER AUTOINCREMENT，直接透传会让界面拿到 number，
 *   而 ClipchanApi 上所有 id 都是 string（remove 再传回去时才不会静默匹配不到）。
 */
function rowToOptimizeHistory(row: OptimizeHistoryRow): OptimizeHistoryEntry {
  return {
    id: String(row.id),
    source: row.source,
    output: row.output,
    sceneId: row.scene_id,
    mode: row.mode === 'system' ? 'system' : 'user',
    providerId: row.provider_id,
    providerName: row.provider_name,
    createdAt: row.created_at,
  };
}

/**
 * 解析 file_paths 列。坏 JSON / 非数组 / null 一律回 []：这是"显示文件个数"的路径，
 * 一条脏数据不该让整个列表读不出来。
 */
function parseFilePaths(v: string | null): string[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * 解析 tags 列。坏 JSON / 非数组 / 非字符串元素一律丢弃，绝不抛：
 * 这是列表投影的必经之路，一条脏标签不该让整页读不出来（与 parseFilePaths 同理）。
 */
function parseTags(v: string | null | undefined): string[] {
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
 * 归一化一批标签：sanitizeTag 去 # / 压空白 / 截 24 码点，再去空、去重。
 *
 * ★ 额外丢掉含 `"` 或 `\` 的标签：过滤走 `tags LIKE '%"tag"%'`，这两个字符会让
 *   引号边界失真（`"a"b"` 之类），宁可不让这种标签存在，也不让过滤条件撒谎。
 */
function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = sanitizeTag(raw);
    if (t.length === 0) continue;
    if (t.includes('"') || t.includes('\\')) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 标签列表 → 入库值。空列表存 NULL 而不是 '[]'：`tags IS NULL` 直接就是"无标签"。 */
function encodeTags(tags: string[]): string | null {
  return tags.length === 0 ? null : JSON.stringify(tags);
}

/** snippets 行 → DTO（字段名转 camelCase）。 */
export function rowToSnippet(row: SnippetRow): Snippet {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    useCount: row.use_count,
  };
}

/** 图片行 → ImageRow。 */
function rowToImageRow(row: ItemRow): ImageRow {
  return {
    id: row.id,
    content: row.content,
    image_path: row.image_path,
    thumb_path: row.thumb_path,
    image_hash: row.image_hash,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    created_at: row.created_at,
    seq: row.seq,
    pinned: row.pinned === 1,
    truncated: row.truncated === 1,
    source: sourceToDto(row.source),
    deleted_at: row.deleted_at,
  };
}

// ---------------- 查询拼装 ----------------

const KIND_GROUPS: Record<KindFilter, Kind[]> = {
  all: ['text', 'link', 'code', 'path', 'number', 'image', 'files'],
  'text-group': ['text', 'path', 'number'],
  favorite: ['text', 'link', 'code', 'path', 'number', 'image', 'files'],
  text: ['text'],
  link: ['link'],
  code: ['code'],
  path: ['path'],
  number: ['number'],
  image: ['image'],
  files: ['files'],
};

/**
 * 图片的"描述文案"——必须与 core 的 previewOfImage 逐字一致（spec §8.1）。
 * 这里由 SQL 现场拼出、**不落库**，图片行 content 为 NULL 所以不会和文本撞。
 */
const IMAGE_DESC_SQL =
  "('图片 ' || width || '×' || height || ' · ' || CAST(bytes / 1024 AS INTEGER) || ' KB')";

/**
 * FolderDTO 平表 → core 的 OrganizeFolder 形状。
 *
 * ★ canMoveFolder / buildFolderTree 都只认 { id, name, parentId }，而 DTO 多一个 itemCount。
 *   在这里剥一次，比让 core 去接受 DTO 更干净（core 不该知道计数从哪来）。
 */
function toOrganizeFolders(folders: FolderDTO[]): OrganizeFolder[] {
  return folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }));
}

/** 只拼 WHERE：list 与 count 必须用同一套条件，否则「共 N 条」和列表对不上。 */
function buildWhere(q: ListQuery): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  // ★ 回收站排除只写这一处：list 与 count 共用它，分别改才是「列表和共 N 条打架」的源头。
  const where: string[] = ['1 = 1', 'deleted_at IS NULL'];

  const kinds = KIND_GROUPS[q.kind ?? 'all'] ?? KIND_GROUPS.all;
  where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
  params.push(...kinds);

  if ((q.kind ?? 'all') === 'favorite') where.push('pinned = 1');

  const term = typeof q.q === 'string' ? q.q.trim() : '';
  if (term.length > 0) {
    // search_index 存的是小写（见 buildSearchIndex），查询串必须同样小写才能命中拼音段。
    // content 那一路也用小写：SQLite 的 LIKE 对 ASCII 本来就大小写不敏感，用同一个小写串
    // 不会漏匹配，却省掉一组额外参数。
    const lowered = term.toLowerCase();
    where.push(
      `(content LIKE '%' || ? || '%' OR search_index LIKE '%' || ? || '%' OR (kind = 'image' AND ${IMAGE_DESC_SQL} LIKE '%' || ? || '%'))`,
    );
    params.push(lowered, lowered, lowered);
  }

  // v1.0.0 ⑧ 时间范围：两端都**含端点**（用户选"今天"时 00:00:00.000 那条也该在）。
  const time = q.time;
  if (time && typeof time === 'object') {
    if (typeof time.from === 'number' && Number.isFinite(time.from)) {
      where.push('created_at >= ?');
      params.push(Math.floor(time.from));
    }
    if (typeof time.to === 'number' && Number.isFinite(time.to)) {
      where.push('created_at <= ?');
      params.push(Math.floor(time.to));
    }
  }

  // v1.0.0 ⑥ 标签：AND 语义，每个标签一段 LIKE。
  // ★ 参数带引号（'"tag"'）是有意的：库里存的是 JSON 数组字符串，
  //   `tags LIKE '%"ab"%'` 不会命中 ["abc"]，等价于"是数组里的一个元素"，
  //   既不用 tags 关联表，也不用把 JSON 塞进 SQL 里解析。含 " 或 \ 的标签在写入时
  //   就被丢掉了（见 normalizeTags），所以这个引号边界永远可靠。
  if (Array.isArray(q.tags)) {
    for (const tag of q.tags) {
      if (typeof tag !== 'string') continue;
      const t = sanitizeTag(tag);
      if (t.length === 0) continue;
      where.push("tags LIKE '%' || ? || '%'");
      params.push('"' + t + '"');
    }
  }

  // v1.0.0 ⑥ 文件夹三态：string=该文件夹；null=只看未归类；undefined=不限。
  // ★ 必须区分 null 与 undefined —— 写成 `q.folderId === null` 才不会把"没传"当成"未归类"。
  if (q.folderId === null) {
    where.push('folder_id IS NULL');
  } else if (typeof q.folderId === 'string') {
    where.push('folder_id = ?');
    params.push(q.folderId);
  }

  return { where: where.join(' AND '), params };
}

/** limit/offset 的夹取规则：list 与 listTrash 共用，别让两个入口算出不同的页大小。 */
function clampPage(q: ListQuery): { limit: number; offset: number } {
  const rawLimit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  const rawOffset = typeof q.offset === 'number' && Number.isFinite(q.offset) ? Math.floor(q.offset) : 0;
  const offset = Math.max(0, rawOffset);
  return { limit, offset };
}

function buildListSql(q: ListQuery): { sql: string; params: unknown[] } {
  const { where, params } = buildWhere(q);
  const { limit, offset } = clampPage(q);
  const sql =
    'SELECT * FROM items WHERE ' + where +
    ' ORDER BY pinned DESC, created_at DESC, seq DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return { sql, params };
}

/**
 * 一次结构化搜索最多扫多少行候选。
 *
 * ★ 有上限是**有意的**：expr 只能在应用层逐行求值（正则 / not / or 都不是 SQL 能力），
 *   而排序是 pinned/created_at 优先，候选一多就是主进程同步扫几十万行。
 *   宁可搜不到极老的记录，也不让一次搜索把界面卡住几十秒。
 */
const SEARCH_SCAN_LIMIT = 20000;

/**
 * 结构化搜索（q.expr）的候选扫描：SQL 只做 buildWhere 里那些能用索引表达的条件，
 * 剩下的交给 core 的 matchSearch 逐行判定。
 *
 * ★ 不带 LIMIT/OFFSET：分页必须发生在**命中之后**，否则"第 2 页"会变成
 *   "候选第 201~400 行里恰好命中的那几条"，条数和排序都会错。
 *   list 与 count 共用它，这样「共 N 条」与列表永远不会分叉。
 */
function scanByExpr(
  raw: Database.Database,
  q: ListQuery,
  where: string,
  params: unknown[],
): ItemRow[] {
  const sql =
    'SELECT * FROM items WHERE ' + where +
    ' ORDER BY pinned DESC, created_at DESC, seq DESC LIMIT ' + SEARCH_SCAN_LIMIT;
  const rows = raw.prepare(sql).all(...params) as ItemRow[];
  const expr = q.expr as SearchNode;
  return rows.filter((row) => {
    // 图片行 content 是 NULL，搜索靠的是现场拼出来的尺寸/体积描述——必须与
    // IMAGE_DESC_SQL 同一段文案，否则"搜 图片 1024"会时而命中时而不命中。
    const isImage = toKind(row.kind) === 'image';
    return matchSearch(expr, {
      text: row.content ?? '',
      searchIndex: row.search_index ?? '',
      imageDesc: isImage ? previewOfImage(row.width ?? 0, row.height ?? 0, row.bytes ?? 0) : undefined,
    });
  });
}

// ---------------- 设置 ----------------

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把任意输入归一化为 auto/light/dark（抄 legacy Settings.NormalizeThemeMode）。 */
function normalizeTheme(v: unknown): Settings['theme'] {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'light' || s === 'dark' ? s : 'auto';
}

/** 把任意输入归一化为四种布局（非法值回落 list）。 */
function normalizeLayout(v: unknown): Settings['listLayout'] {
  return v === 'timeline' || v === 'masonry' || v === 'source' ? v : 'list';
}

/**
 * 排除应用名单归一化：只留 exe 文件名（小写、去路径、去空白、去重）。
 *
 * 用户可能粘贴 `C:\Program Files\1Password\1Password.exe`，也可能只写 `1password.exe`；
 * 统一取 basename 再比，才不会因为写法不同而漏排除（漏排除 = 密码明文永久落库）。
 */
export function normalizeExcludeApps(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const base = raw.trim().split(/[\\/]/).pop() ?? '';
    const name = base.trim().toLowerCase();
    if (name.length === 0) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out.slice(0, 50);
}

/** 逐键清洗，非法值一律回落默认值——旧库被手改过也不至于把界面搞崩。 */
function sanitizeSettings(input: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    theme: input.theme === undefined ? d.theme : normalizeTheme(input.theme),
    historyLimit: input.historyLimit === undefined ? d.historyLimit : clampInt(input.historyLimit, 1, 9999, d.historyLimit),
    imageBudgetMB: input.imageBudgetMB === undefined ? d.imageBudgetMB : clampInt(input.imageBudgetMB, 1, 102400, d.imageBudgetMB),
    widgetSize: input.widgetSize === undefined ? d.widgetSize : clampInt(input.widgetSize, 240, 400, d.widgetSize),
    widgetCorner: input.widgetCorner === 'remember' || input.widgetCorner === 'bottom-right' ? input.widgetCorner : d.widgetCorner,
    hideOnBlur: input.hideOnBlur === undefined ? d.hideOnBlur : !!input.hideOnBlur,
    autoPaste: input.autoPaste === undefined ? d.autoPaste : !!input.autoPaste,
    hotkeyActivate: typeof input.hotkeyActivate === 'string' && input.hotkeyActivate.length > 0 ? input.hotkeyActivate : d.hotkeyActivate,
    hotkeyWidget: typeof input.hotkeyWidget === 'string' && input.hotkeyWidget.length > 0 ? input.hotkeyWidget : d.hotkeyWidget,
    hotkeyCapture: typeof input.hotkeyCapture === 'string' && input.hotkeyCapture.length > 0 ? input.hotkeyCapture : d.hotkeyCapture,
    trashLimit: input.trashLimit === undefined ? d.trashLimit : clampInt(input.trashLimit, 1, 9999, d.trashLimit),
    listLayout: input.listLayout === undefined ? d.listLayout : normalizeLayout(input.listLayout),
    excludeApps: Array.isArray(input.excludeApps) ? normalizeExcludeApps(input.excludeApps) : d.excludeApps,
  };
}

// ---------------- openDb ----------------

/**
 * 打开（必要时创建）数据库。传 ':memory:' 可用于单测。
 * 目录不存在时自动创建。
 */
export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const raw = new Database(file);
  // WAL：spec §9.1 注明实测可用。内存库不支持 WAL，跳过。
  if (file !== ':memory:') {
    try {
      raw.pragma('journal_mode = WAL');
    } catch {
      // 只读介质 / 网络盘等场景下 WAL 会失败，不影响功能
    }
  }
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA_SQL);

  // 老库可能缺列：用 PRAGMA 检查后补，避免"升级即崩"。
  ensureColumns(raw);
  // ★ 顺序不能换：索引谓词引用 deleted_at，必须等 ensureColumns 补完列才建；
  //   同时 SQLite 没有 ALTER INDEX，旧谓词的索引只能 drop 后重建。
  migrateTrashSchema(raw);

  const settingsCache: Settings = loadSettings(raw);

  function nextSeq(): number {
    return nextSeqOf(raw);
  }

  /**
   * 找一条**视觉相近**的图片记录，返回它的 id；没有就回 undefined。
   *
   * ★ 只扫最近 200 条图片行（按 created_at 倒序）：感知哈希的比较是 O(n) 的逐字符比较，
   *   而"刚复制进来的图很可能跟刚存的那几张重复"是唯一有实用价值的场景；
   *   翻遍全库既慢又没什么额外收获。
   * ★ 排除自己（id != ?）：调用方在插入前调用，正常不会有自己，但带上这个条件
   *   才让"先插后判"或重入调用也不会把自己认成自己的相似项。
   */
  function findSimilarImage(selfId: string, phash: string): string | undefined {
    const rows = raw.prepare(
      `SELECT id, phash FROM items
        WHERE deleted_at IS NULL AND kind = 'image' AND phash IS NOT NULL AND id != ?
        ORDER BY created_at DESC LIMIT 200`,
    ).all(selfId) as { id: string; phash: string }[];
    for (const row of rows) {
      if (hammingDistance(phash, row.phash) <= SIMILAR_HAMMING_THRESHOLD) return row.id;
    }
    return undefined;
  }

  /**
   * 行 → DTO，并给 kind='link' 的记录挂上 URL 预览缓存。
   *
   * ★ 刻意**不改** buildListSql / buildWhere 的 SQL（不做 JOIN）：列表 SQL 是分页与
   *   「共 N 条」共用的地基，加一个 LEFT JOIN 会同时改掉两者的行数与排序风险；
   *   缓存表是纯装饰，在 JS 侧一次性批量查更安全，也让"未命中"天然就是"不挂字段"。
   * ★ 未命中时**不设** urlPreview 键（而不是设成 undefined）：调用方用
   *   "urlPreview" in dto 就能如实判断有没有缓存，IPC 载荷也少一堆空键。
   */
  function attachUrlPreviews(rows: ItemRow[]): ClipItemDTO[] {
    const dtos = rows.map(rowToDto);
    const linkUrls = new Set<string>();
    for (const row of rows) {
      if (row.kind !== 'link') continue;
      const url = row.content;
      if (typeof url === 'string' && url.length > 0) linkUrls.add(url);
    }
    if (linkUrls.size === 0) return dtos;
    const previews = new Map<string, UrlPreviewDTO>();
    for (const pv of api.getUrlPreviews([...linkUrls])) previews.set(pv.url, pv);
    if (previews.size === 0) return dtos;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const dto = dtos[i];
      if (!row || !dto || row.kind !== 'link') continue;
      const url = row.content;
      if (typeof url !== 'string') continue;
      const pv = previews.get(url);
      if (pv) dto.urlPreview = pv;
    }
    return dtos;
  }

  /** 命中去重：同时刷新 created_at 与 seq（spec §7.4 的 ★）。 */
  function touchRow(id: string, now?: number): void {
    const at = typeof now === 'number' ? now : Date.now();
    raw.prepare('UPDATE items SET created_at = ?, seq = ? WHERE id = ?').run(at, nextSeq(), id);
    evictOverLimit();
  }

  /**
   * 按 Settings.historyLimit 淘汰**未收藏**记录：只保留最新的 limit 条未收藏，
   * 收藏记录不参与、不计入上限（计划 Task 2 第 5 步 / legacy Store.Trim）。
   *
   * ★ v0.3.0 起淘汰 = 进回收站（软删），不删盘：上限淘汰不该是唯一一条"删了就没"的路径。
   *   子查询也必须只数**活跃**行，否则回收站行会占住名额、把活跃记录多淘汰出去。
   */
  function evictOverLimit(): void {
    const limit = settingsCache.historyLimit;
    if (!Number.isFinite(limit) || limit <= 0) return;
    raw.prepare(
      `UPDATE items SET deleted_at = ?
        WHERE deleted_at IS NULL
          AND pinned = 0
          AND id NOT IN (
            SELECT id FROM items WHERE deleted_at IS NULL AND pinned = 0 ORDER BY created_at DESC, seq DESC LIMIT ?
          )`,
    ).run(Date.now(), Math.floor(limit));
    purgeTrashOverLimit();
  }

  /**
   * 恢复一条：清掉 deleted_at，created_at / seq 保持原值（位置回到原处）。
   *
   * ★ 冲突时返回 0 而不是抛：删掉一条内容后，用户很可能又复制了同样的东西，
   *   此时活跃行已占住这个 content_hash，而唯一索引的谓词是「活跃行唯一」。
   *   直接 UPDATE 会撞 SQLITE_CONSTRAINT_UNIQUE，把整条 IPC 调用炸掉——
   *   恢复是用户点的"撤销"，不该因为内容重复就报错崩界面。跳过它、由调用方
   *   回报"实际恢复了几条"更合适。
   */
  function restoreOne(conn: Database.Database, id: string): number {
    try {
      return conn.prepare('UPDATE items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return 0;
      throw err;
    }
  }

  /**
   * 回收站独立上限：超出 Settings.trashLimit 的最旧回收站行**硬删**（这一族才删盘）。
   *
   * 返回被删 id 让调用方去删文件——db 层不认识文件系统。这里是全表唯一的硬删入口，
   * 所以它不受 historyLimit 影响，两条上限各管各的。
   */
  function purgeTrashOverLimit(): string[] {
    const limit = settingsCache.trashLimit;
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const rows = raw
      .prepare(
        `SELECT id FROM items
          WHERE deleted_at IS NOT NULL
          ORDER BY deleted_at DESC, seq DESC LIMIT -1 OFFSET ?`,
      )
      .all(Math.floor(limit)) as { id: string }[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const del = raw.prepare('DELETE FROM items WHERE id = ?');
    const tx = raw.transaction((list: string[]) => {
      for (const id of list) del.run(id);
    });
    tx(ids);
    return ids;
  }


  /**
   * 优化历史的上限淘汰：只保留最新 OPTIMIZE_HISTORY_LIMIT 条，多的**硬删**。
   *
   * ★ 与 items 的上限淘汰不同，这里不软删也不进回收站：历史是"重新灌回输入框"的
   *   便签，留 100 条以外的东西既没人翻也占库；而用户要的"清空全部"已经另有入口。
   */
  function trimOptimizeHistory(): void {
    raw.prepare(
      `DELETE FROM optimize_history
        WHERE id NOT IN (
          SELECT id FROM optimize_history ORDER BY created_at DESC, id DESC LIMIT ?
        )`,
    ).run(OPTIMIZE_HISTORY_LIMIT);
  }

  /**
   * 片段上限淘汰：只保留 updated_at 最新的 SNIPPET_LIMIT 条，多的**硬删**。
   *
   * ★ 与 optimize_history 同理不软删：片段库没有回收站入口，删了就该真的没了；
   *   而"上限到了还往里存"本身是用户的显式动作，不该让他事后在回收站里翻。
   */
  function trimSnippets(): void {
    raw.prepare(
      `DELETE FROM snippets
        WHERE id NOT IN (
          SELECT id FROM snippets ORDER BY updated_at DESC, id DESC LIMIT ?
        )`,
    ).run(SNIPPET_LIMIT);
  }

  const api: Db = {
    raw,

    insertText(text: string, opts: InsertTextOpts = {}): InsertResult {
      if (typeof text !== 'string') throw new Error('insertText: text 必须是字符串');
      const cleaned = text.replace(/\0/g, '');
      if (cleaned.length === 0) throw new Error('insertText: 空文本不入库');

      const richHtml = typeof opts.richHtml === 'string' && opts.richHtml.length > 0 ? opts.richHtml : null;

      let content = cleaned;
      let truncated = opts.truncated === true;
      if (content.length > TEXT_LIMIT) {
        content = content.slice(0, TEXT_LIMIT);
        truncated = true;
      }

      const hash = hashText(content);
      // ★ 去重只认活跃行：命中回收站里的行会刷新一条已删记录的排序，用户复制完什么都不出现。
      const hit = raw.prepare('SELECT id, rich_html FROM items WHERE content_hash = ? AND deleted_at IS NULL').get(hash) as
        | { id: string; rich_html: string | null }
        | undefined;
      if (hit) {
        // ★ 旧行没有富文本、这次有：补写。否则同一段文字先从纯文本来源复制过、
        //   再从网页复制，就永远拿不到 text/html —— 用户看到的加粗/表格全丢了。
        if (richHtml !== null && (hit.rich_html === null || hit.rich_html.length === 0)) {
          raw.prepare('UPDATE items SET rich_html = ? WHERE id = ?').run(richHtml, hit.id);
        }
        touchRow(hit.id, typeof opts.now === 'number' ? opts.now : undefined);
        return { id: hit.id, touched: true };
      }

      const id = randomUUID().replace(/-/g, '');
      const createdAt = typeof opts.now === 'number' ? opts.now
        : typeof opts.createdAt === 'number' ? opts.createdAt
        : Date.now();
      const seq = typeof opts.seq === 'number' ? opts.seq : nextSeq();
      const kind = opts.kind ?? classify(content);
      raw.prepare(
        `INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq, source_app,
                            rich_html, search_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, kind, content, hash, sourceToDb(opts.source), opts.pinned ? 1 : 0, truncated ? 1 : 0, createdAt, seq,
        sourceAppToDb(opts.sourceApp), richHtml, buildSearchIndex(content),
      );
      evictOverLimit();
      return { id, touched: false };
    },

    insertImage(meta: ImageMeta, opts: InsertImageOpts = {}): InsertResult {
      if (!meta || typeof meta.hash !== 'string' || meta.hash.length === 0) {
        throw new Error('insertImage: 缺少 hash');
      }
      const hit = raw.prepare('SELECT id FROM items WHERE image_hash = ? AND deleted_at IS NULL').get(meta.hash) as
        | { id: string }
        | undefined;
      if (hit) {
        const explicit = opts.now ?? opts.createdAt ?? meta.createdAt;
        touchRow(hit.id, typeof explicit === 'number' ? explicit : undefined);
        return { id: hit.id, touched: true };
      }

      const id = randomUUID().replace(/-/g, '');
      const explicit = opts.now ?? opts.createdAt ?? meta.createdAt;
      const createdAt = typeof explicit === 'number' ? explicit : Date.now();
      const seq = typeof (opts.seq ?? meta.seq) === 'number'
        ? (opts.seq ?? meta.seq) as number
        : nextSeq();
      const pinned = opts.pinned ?? meta.pinned ?? false;
      const source = sourceToDb(opts.source ?? meta.source);
      const phash = typeof meta.phash === 'string' && meta.phash.length > 0 ? meta.phash : null;
      // ★ 相似判定必须在插入**之前**做（新行还没进库，扫不到自己）；只在有 phash 时才扫，
      //   没有 phash 的图片连一次查询都不该多付。
      const similarTo = phash === null ? undefined : findSimilarImage(id, phash);
      raw.prepare(
        `INSERT INTO items (id, kind, content, content_hash, image_path, image_hash, thumb_path,
                            width, height, bytes, source, pinned, truncated, created_at, seq, source_app, phash)
         VALUES (?, 'image', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        id, meta.imagePath, meta.hash, meta.thumbPath,
        Math.max(0, Math.round(meta.width)), Math.max(0, Math.round(meta.height)), Math.max(0, Math.round(meta.bytes)),
        source, pinned ? 1 : 0, createdAt, seq, sourceAppToDb(opts.sourceApp), phash,
      );
      evictOverLimit();
      // ★ 相似不等于相同：记录**照样入库**（剪贴板是用户的数据，静默丢弃比留一条重复更糟），
      //   这里只是把"库里已有一条很像的"告诉调用方，由它决定要不要提示一句。
      return similarTo === undefined ? { id, touched: false } : { id, touched: false, similarTo };
    },

    /**
     * 记录"复制的文件"。
     *
     * ★ 去重键是路径列表整体（\n 连接后的 sha256），不是文件个数：复制同一批文件两次
     *   要命中同一行；复制同名但不同目录的文件必须是两条。
     * ★ 命中时不覆盖已有 file_paths —— 内容相同就是同一批路径，覆盖只会把用户
     *   更早那次（可能是短名）的记录改掉。
     */
    insertFiles(paths: string[], opts: InsertFilesOpts = {}): InsertResult {
      const list = Array.isArray(paths) ? paths.filter((x) => typeof x === 'string' && x.length > 0) : [];
      if (list.length === 0) return { id: '', touched: false };

      const hash = hashText(list.join('\n'));
      const hit = raw.prepare('SELECT id FROM items WHERE content_hash = ? AND deleted_at IS NULL').get(hash) as
        | { id: string }
        | undefined;
      if (hit) {
        touchRow(hit.id, typeof opts.now === 'number' ? opts.now : undefined);
        return { id: hit.id, touched: true };
      }

      const content = filesDesc(list.length, baseNameOf(list[0] ?? ''));
      const id = randomUUID().replace(/-/g, '');
      const createdAt = typeof opts.now === 'number' ? opts.now
        : typeof opts.createdAt === 'number' ? opts.createdAt
        : Date.now();
      const seq = typeof opts.seq === 'number' ? opts.seq : nextSeq();
      raw.prepare(
        `INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq, source_app,
                            file_paths, search_index)
         VALUES (?, 'files', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      ).run(
        id, content, hash, sourceToDb(opts.source), opts.pinned ? 1 : 0, createdAt, seq,
        sourceAppToDb(opts.sourceApp), JSON.stringify(list), buildSearchIndex(content),
      );
      evictOverLimit();
      return { id, touched: false };
    },

    getFilePaths(id: string): string[] {
      const row = raw.prepare('SELECT file_paths FROM items WHERE id = ?').get(id) as
        | { file_paths: string | null }
        | undefined;
      return parseFilePaths(row?.file_paths ?? null);
    },

    getRichHtml(id: string): string | null {
      const row = raw.prepare('SELECT rich_html FROM items WHERE id = ?').get(id) as
        | { rich_html: string | null }
        | undefined;
      const html = row?.rich_html ?? null;
      return typeof html === 'string' && html.length > 0 ? html : null;
    },

    /**
     * 列表。没有 q.expr 时完全走 SQL 分页（零行为变化）；有 expr 时先扫候选再切片。
     *
     * ★ expr 与 q 同时给时以 expr 为准：parseSearch 已经把自由文本收进 text 叶子，
     *   再叠一层 q 的 LIKE 只会把结果收窄成"两套规则的交集"，用户看到的命中会莫名变少。
     */
    list(q: ListQuery = {}): ClipItemDTO[] {
      if (!q.expr) {
        const { sql, params } = buildListSql(q);
        const rows = raw.prepare(sql).all(...params) as ItemRow[];
        return attachUrlPreviews(rows);
      }
      const base: ListQuery = { ...q, q: undefined };
      const { where, params } = buildWhere(base);
      const hits = scanByExpr(raw, q, where, params);
      const { limit, offset } = clampPage(q);
      return attachUrlPreviews(hits.slice(offset, offset + limit));
    },

    count(q: ListQuery = {}): number {
      if (!q.expr) {
        const { where, params } = buildWhere(q);
        const row = raw.prepare('SELECT COUNT(*) AS n FROM items WHERE ' + where).get(...params) as
          | { n: number }
          | undefined;
        return row ? row.n : 0;
      }
      // ★ 与 list 共用 scanByExpr：命中集合必须完全相同，否则「共 N 条」和列表打架。
      const base: ListQuery = { ...q, q: undefined };
      const { where, params } = buildWhere(base);
      return scanByExpr(raw, q, where, params).length;
    },

    /**
     * 软删一条：只盖 deleted_at，不删行、不删盘。
     * 返回盖戳前的行（调用方拿图片相对路径用），已经删除过的 id 返回 null。
     */
    remove(id: string): ItemRow | null {
      const row = raw.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').get(id) as
        | ItemRow
        | undefined;
      if (!row) return null;
      raw.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
      purgeTrashOverLimit();
      return row;
    },

    removeMany(ids: string[]): ItemRow[] {
      if (!ids || ids.length === 0) return [];
      const sel = raw.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL');
      const upd = raw.prepare('UPDATE items SET deleted_at = ? WHERE id = ?');
      const out: ItemRow[] = [];
      const at = Date.now();
      const tx = raw.transaction((list: string[]) => {
        for (const id of list) {
          const row = sel.get(id) as ItemRow | undefined;
          if (row) {
            upd.run(at, id);
            out.push(row);
          }
        }
      });
      tx(ids);
      purgeTrashOverLimit();
      return out;
    },

    togglePin(id: string): boolean {
      const info = raw.prepare('UPDATE items SET pinned = CASE pinned WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
      return info.changes > 0;
    },

    pinMany(ids: string[], pinned: boolean): number {
      const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x.length > 0) : [];
      if (list.length === 0) return 0;
      // 占位符按条数拼，id 永远走参数绑定 —— 拼字符串就是 SQL 注入。
      const marks = list.map(() => '?').join(', ');
      const info = raw
        .prepare(`UPDATE items SET pinned = ? WHERE id IN (${marks}) AND deleted_at IS NULL`)
        .run(pinned ? 1 : 0, ...list);
      return info.changes;
    },

    clearUnpinned(): ItemRow[] {
      const rows = raw.prepare('SELECT * FROM items WHERE pinned = 0 AND deleted_at IS NULL').all() as ItemRow[];
      raw.prepare('UPDATE items SET deleted_at = ? WHERE pinned = 0 AND deleted_at IS NULL').run(Date.now());
      purgeTrashOverLimit();
      return rows;
    },

    clearAll(): number {
      // ★ 只清**活跃**行：已在回收站里的记录不该被这次操作改写删除时间
      //   （那会让"清空列表"顺手把回收站的排序也搅乱）。
      const n = raw
        .prepare('UPDATE items SET deleted_at = ? WHERE deleted_at IS NULL')
        .run(Date.now()).changes;
      purgeTrashOverLimit();
      return n;
    },

    listTrash(q: { limit?: number; offset?: number } = {}): ClipItemDTO[] {
      // 谓词与 buildWhere 相反（只取已删），所以不复用它——复用只会让两边一起改坏。
      const rawLimit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : DEFAULT_LIMIT;
      const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
      const rawOffset = typeof q.offset === 'number' && Number.isFinite(q.offset) ? Math.floor(q.offset) : 0;
      const offset = Math.max(0, rawOffset);
      const rows = raw
        .prepare(
          `SELECT * FROM items WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC, seq DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as ItemRow[];
      return rows.map(rowToDto);
    },

    countTrash(): number {
      const row = raw.prepare('SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NOT NULL').get() as
        | { n: number }
        | undefined;
      return row ? row.n : 0;
    },

    restore(id: string): boolean {
      return restoreOne(raw, id) > 0;
    },

    restoreMany(ids: string[]): number {
      if (!ids || ids.length === 0) return 0;
      const tx = raw.transaction((list: string[]) => {
        let n = 0;
        for (const id of list) n += restoreOne(raw, id);
        return n;
      });
      return tx(ids);
    },

    purge(ids: string[]): number {
      if (!ids || ids.length === 0) return 0;
      const del = raw.prepare('DELETE FROM items WHERE id = ?');
      const tx = raw.transaction((list: string[]) => {
        let n = 0;
        for (const id of list) n += del.run(id).changes;
        return n;
      });
      return tx(ids);
    },

    purgeTrashOverLimit(): string[] {
      return purgeTrashOverLimit();
    },

    getSettings(): Settings {
      return { ...settingsCache };
    },

    getSettingValue<T = unknown>(key: string): T | undefined {
      const row = raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row) return undefined;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        // 单条损坏按"没有这个键"处理（与 loadSettings 的容错一致）。
        return undefined;
      }
    },

    setSettingValue(key: string, value: unknown): void {
      raw
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value ?? null));
    },

    setSettings(patch: Partial<Settings>): Settings {
      const merged = sanitizeSettings({ ...settingsCache, ...(patch ?? {}) });
      const upsert = raw.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      // 直查/直写 settings 表：走 getSettings()/setSettings() 会被白名单裁掉，
      // 而 Key 与 provider 元数据刻意不进 settingsCache（settings:get 不许带它们出去）。
      const tx = raw.transaction((s: Settings) => {
        for (const [k, v] of Object.entries(s)) upsert.run(k, JSON.stringify(v));
      });
      tx(merged);
      Object.assign(settingsCache, merged);
      return { ...settingsCache };
    },

    getRow(id: string): ItemRow | null {
      const row = raw.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
      return row ?? null;
    },

    addOptimizeHistory(e: Omit<OptimizeHistoryEntry, 'id'>): OptimizeHistoryEntry {
      const info = raw.prepare(
        `INSERT INTO optimize_history (source, output, scene_id, mode, provider_id, provider_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.source, e.output, e.sceneId, e.mode, e.providerId, e.providerName, e.createdAt);
      // 上限淘汰紧跟插入：不这样做的话，一次批量写入会把上限拖到下一次读才发现。
      trimOptimizeHistory();
      const row = raw.prepare('SELECT * FROM optimize_history WHERE id = ?').get(info.lastInsertRowid) as
        | OptimizeHistoryRow
        | undefined;
      // 刚插入就被淘汰说明上限 <= 0（不可能，常量是 100），兜底按入参回显而不是抛。
      return row ? rowToOptimizeHistory(row) : { ...e, id: String(info.lastInsertRowid) };
    },

    listOptimizeHistory(limit?: number): OptimizeHistoryEntry[] {
      const sql = 'SELECT * FROM optimize_history ORDER BY created_at DESC, id DESC';
      const rows = typeof limit === 'number' && Number.isFinite(limit)
        ? raw.prepare(sql + ' LIMIT ?').all(Math.max(0, Math.floor(limit))) as OptimizeHistoryRow[]
        : raw.prepare(sql).all() as OptimizeHistoryRow[];
      return rows.map(rowToOptimizeHistory);
    },

    removeOptimizeHistory(id: string): boolean {
      // id 是 TEXT AUTOINCREMENT 的字符串投影：非数字 id 直接当"不存在"，不让 SQLite 静默转 0。
      if (!/^\d+$/.test(id)) return false;
      return raw.prepare('DELETE FROM optimize_history WHERE id = ?').run(Number(id)).changes > 0;
    },

    clearOptimizeHistory(): number {
      return raw.prepare('DELETE FROM optimize_history').run().changes;
    },

    getText(id: string): string {
      const row = raw.prepare('SELECT content, kind FROM items WHERE id = ?').get(id) as
        | { content: string | null; kind: string }
        | undefined;
      // 图片行 content 为 NULL；不存在的 id 也没有 content —— 两种都按空串返回。
      if (!row || row.kind === 'image') return '';
      return row.content ?? '';
    },

    getImageRow(id: string): ImageRow | null {
      const row = raw.prepare("SELECT * FROM items WHERE id = ? AND kind = 'image'").get(id) as ItemRow | undefined;
      return row ? rowToImageRow(row) : null;
    },

    allImageRows(opts: { unpinnedOnly?: boolean } = {}): ImageRow[] {
      const sql = opts.unpinnedOnly
        ? "SELECT * FROM items WHERE kind = 'image' AND pinned = 0 ORDER BY created_at ASC, seq ASC"
        : "SELECT * FROM items WHERE kind = 'image' ORDER BY created_at ASC, seq ASC";
      return (raw.prepare(sql).all() as ItemRow[]).map(rowToImageRow);
    },

    touch(id: string): void {
      touchRow(id);
    },

    listSnippets(): Snippet[] {
      return raw
        .prepare('SELECT * FROM snippets ORDER BY updated_at DESC, id DESC')
        .all()
        .map((row) => rowToSnippet(row as SnippetRow));
    },

    /**
     * 新增或更新一条片段。
     *
     * ★ 更新分支**不动** created_at 与 use_count：改标题/内容不该让"创建时间"和
     *   "用了多少次"归零，否则常用的片段一编辑就掉到列表末尾。
     * ★ title 允许空串：UI 用内容首行兜底，db 层不替它编一个名字出来。
     */
    saveSnippet(input: SnippetInput): Snippet[] {
      const title = typeof input?.title === 'string' ? input.title : '';
      const content = typeof input?.content === 'string' ? input.content : '';
      const at = Date.now();
      const id = typeof input?.id === 'string' && input.id.length > 0 ? input.id : '';

      const existing = id.length > 0
        ? raw.prepare('SELECT id FROM snippets WHERE id = ?').get(id) as { id: string } | undefined
        : undefined;

      if (existing) {
        raw.prepare('UPDATE snippets SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(title, content, at, id);
      } else {
        raw.prepare(
          `INSERT INTO snippets (id, title, content, created_at, updated_at, use_count)
           VALUES (?, ?, ?, ?, ?, 0)`,
        ).run(id.length > 0 ? id : randomUUID().replace(/-/g, ''), title, content, at, at);
      }
      trimSnippets();
      return api.listSnippets();
    },

    removeSnippet(id: string): Snippet[] {
      raw.prepare('DELETE FROM snippets WHERE id = ?').run(id);
      return api.listSnippets();
    },

    touchSnippet(id: string): Snippet[] {
      raw.prepare('UPDATE snippets SET use_count = use_count + 1 WHERE id = ?').run(id);
      return api.listSnippets();
    },

    getSnippet(id: string): Snippet | null {
      const row = raw.prepare('SELECT * FROM snippets WHERE id = ?').get(id) as SnippetRow | undefined;
      return row ? rowToSnippet(row) : null;
    },

    /**
     * 文件夹平表 + 每个文件夹的**活跃**记录数。
     *
     * ★ itemCount 用一条 GROUP BY 的 LEFT JOIN 取，不是逐文件夹 count：
     *   树里十来个文件夹就是十几次全表扫，而这条 SQL 只扫一遍。
     * ★ 只数 deleted_at IS NULL 且 folder_id 非空的行：回收站里的记录不该还占着
     *   文件夹的计数（用户看着"3 条"点进去只有 2 条）。不含子文件夹——
     *   子文件夹的条数由渲染层的树自己加总。
     */
    listFolders(): FolderDTO[] {
      const rows = raw
        .prepare(
          `SELECT f.id AS id, f.name AS name, f.parent_id AS parent_id,
                  COALESCE(c.n, 0) AS item_count
             FROM folders f
             LEFT JOIN (
               SELECT folder_id, COUNT(*) AS n FROM items
                WHERE deleted_at IS NULL AND folder_id IS NOT NULL
                GROUP BY folder_id
             ) c ON c.folder_id = f.id
            ORDER BY f.created_at ASC, f.id ASC`,
        )
        .all() as { id: string; name: string; parent_id: string | null; item_count: number }[];
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        parentId: typeof r.parent_id === 'string' && r.parent_id.length > 0 ? r.parent_id : null,
        itemCount: r.item_count,
      }));
    },

    /**
     * 新建文件夹。
     *
     * ★ 名字归一后为空 → 不建、返回原表，不抛：这是用户在输入框里敲了个空格就回车，
     *   弹一个错误对话框比"什么都没发生"更烦人。
     * ★ 父不存在 → 当顶层而不是拒绝：父可能在另一个窗口里刚被删掉。
     * ★ 深度校验把候选节点先塞进列表再问 canMoveFolder —— 复用它同一套规则，
     *   别在这里另写一份"算深度"的逻辑，两份迟早会不一致。
     */
    createFolder(input: FolderInput): FolderDTO[] {
      const name = sanitizeTag(typeof input?.name === 'string' ? input.name : '');
      const existing = api.listFolders();
      if (name.length === 0) return existing;

      const wanted = typeof input?.parentId === 'string' && input.parentId.length > 0 ? input.parentId : null;
      const parentId = wanted !== null && existing.some((f) => f.id === wanted) ? wanted : null;

      const id = randomUUID().replace(/-/g, '');
      const candidate: OrganizeFolder[] = [...toOrganizeFolders(existing), { id, name, parentId }];
      if (!canMoveFolder(candidate, id, parentId)) return existing;

      raw
        .prepare('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, name, parentId, Date.now());
      return api.listFolders();
    },

    /** 改名。id 不存在或新名归一后为空 → 原表不变（不抛）。 */
    renameFolder(id: string, name: string): FolderDTO[] {
      const clean = sanitizeTag(typeof name === 'string' ? name : '');
      if (clean.length === 0) return api.listFolders();
      raw.prepare('UPDATE folders SET name = ? WHERE id = ?').run(clean, id);
      return api.listFolders();
    },

    /**
     * 改父级。成环 / 超深 / 目标不存在 / id 不存在 → 原表不变，不抛。
     *
     * ★ 防环交给 canMoveFolder（它会从目标往上爬，撞到自己就拒绝）：一次误拖
     *   若真把 A 挂到 A 的子节点下，整棵树就从"森林"退化成环，界面会整块消失。
     */
    moveFolder(id: string, parentId: string | null): FolderDTO[] {
      const existing = api.listFolders();
      const target = typeof parentId === 'string' && parentId.length > 0 ? parentId : null;
      if (!canMoveFolder(toOrganizeFolders(existing), id, target)) return existing;
      raw.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(target, id);
      return api.listFolders();
    },

    /**
     * 删文件夹。
     *
     * ★ 里面的记录**回到未归类**（folder_id = NULL），绝不跟着删：用户删的是
     *   "这个分类"，不是"这些剪贴板历史"。
     * ★ 子文件夹**提升为顶层**（parent_id = NULL），不级联删：级联删会把用户
     *   建的整棵结构一次带走，而他只点了最上面那一个。
     * ★ 三步放同一个事务：中途崩溃留下"记录已置空、文件夹还在"的中间态，
     *   比没删更让人困惑。
     */
    removeFolder(id: string): FolderDTO[] {
      const tx = raw.transaction(() => {
        raw.prepare('UPDATE items SET folder_id = NULL WHERE folder_id = ?').run(id);
        raw.prepare('UPDATE folders SET parent_id = NULL WHERE parent_id = ?').run(id);
        raw.prepare('DELETE FROM folders WHERE id = ?').run(id);
      });
      tx();
      return api.listFolders();
    },

    /** 整体替换标签；归一化后为空就存 NULL（`tags IS NULL` 即"无标签"）。 */
    setTags(id: string, tags: string[]): void {
      raw.prepare('UPDATE items SET tags = ? WHERE id = ?').run(encodeTags(normalizeTags(tags)), id);
    },

    getTags(id: string): string[] {
      const row = raw.prepare('SELECT tags FROM items WHERE id = ?').get(id) as
        | { tags: string | null }
        | undefined;
      return parseTags(row?.tags ?? null);
    },

    /**
     * 标签统计：每个标签被多少条**活跃**记录用过。
     *
     * ★ 在 JS 里累加而不是写 SQL：tags 是一列 JSON 数组，SQLite 端拆开要靠
     *   json_each + GROUP BY，比"扫一遍标签列"更难读也更难兜脏数据；
     *   这里复用 parseTags（坏 JSON / 非数组一律当没标签），一条脏标签不该让
     *   整个筛选面板打不开。行数上限是 historyLimit（几百），代价可忽略。
     * ★ 同一条记录里重复的标签只算一次：用 Set 去重后再累加，否则用户手写的
     *   脏数据（setTags 之前的历史行）会让计数虚高。
     * ★ 排序 count 降序 + tag 升序（localeCompare('zh')）：同频标签按拼音排，
     *   面板位置才稳定，不会因为 Map 插入顺序变化而抖动。
     */
    listTags(): TagCountDTO[] {
      const rows = raw
        .prepare('SELECT tags FROM items WHERE deleted_at IS NULL AND tags IS NOT NULL')
        .all() as { tags: string | null }[];
      const counter = new Map<string, number>();
      for (const row of rows) {
        for (const tag of new Set(parseTags(row.tags))) {
          counter.set(tag, (counter.get(tag) ?? 0) + 1);
        }
      }
      const out: TagCountDTO[] = [];
      for (const [tag, count] of counter) out.push({ tag, count });
      out.sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, 'zh'));
      return out;
    },

    /**
     * 把记录放进文件夹；folderId=null 表示移出到未归类。
     *
     * ★ 目标文件夹不存在时落 NULL 而不是照写：库里没有外键兜底，写一个悬空 id 的
     *   结果是这条记录既不出现在任何文件夹里、也不出现在"未归类"里，等于从界面上消失。
     */
    setFolder(id: string, folderId: string | null): void {
      const wanted = typeof folderId === 'string' && folderId.length > 0 ? folderId : null;
      const exists = wanted === null
        ? false
        : raw.prepare('SELECT 1 AS ok FROM folders WHERE id = ?').get(wanted) !== undefined;
      raw.prepare('UPDATE items SET folder_id = ? WHERE id = ?').run(exists ? wanted : null, id);
    },

    /**
     * 写一条 URL 预览缓存。
     * ★ 主键就是 url，用 ON CONFLICT 覆盖而不是先查后写：抓取是异步的、可能并发，
     *   一次原子 upsert 不需要额外的"存在性判断 + 分支"。
     */
    upsertUrlPreview(p: UrlPreviewInput): void {
      const url = typeof p?.url === 'string' ? p.url : '';
      // 空 url 不落行：它既查不回来，也会让"缓存里有什么"这件事失真。
      if (url.length === 0) return;
      raw.prepare(
        `INSERT INTO url_previews (url, title, domain, icon_url, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           domain = excluded.domain,
           icon_url = excluded.icon_url,
           fetched_at = excluded.fetched_at`,
      ).run(
        url,
        typeof p.title === 'string' ? p.title : '',
        typeof p.domain === 'string' ? p.domain : '',
        typeof p.iconUrl === 'string' ? p.iconUrl : '',
        typeof p.fetchedAt === 'number' ? p.fetchedAt : 0,
      );
    },

    /**
     * 批量读 URL 预览缓存。
     * ★ 上限 500 个 url：SQLite 的变量上限（默认 999）是硬约束，一页列表最多 500 条
     *   （MAX_LIMIT），所以截到 500 既够用又永远撞不到上限。
     * ★ 占位符按条数拼、值全部走参数绑定 —— 拼字符串就是 SQL 注入。
     */
    getUrlPreviews(urls: string[]): UrlPreviewDTO[] {
      const list = Array.isArray(urls)
        ? urls.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [];
      if (list.length === 0) return [];
      const capped = list.slice(0, 500);
      const marks = capped.map(() => '?').join(', ');
      const rows = raw.prepare(
        `SELECT url, title, domain, icon_url, fetched_at FROM url_previews WHERE url IN (${marks})`,
      ).all(...capped) as { url: string; title: string; domain: string; icon_url: string; fetched_at: number }[];
      return rows.map((r) => ({
        url: r.url,
        title: r.title,
        domain: r.domain,
        iconUrl: r.icon_url,
        fetchedAt: r.fetched_at,
      }));
    },

    close(): void {
      raw.close();
    },
  };

  return api;
}

/** 读取 settings 表；缺键回落默认值。整表读进内存（spec §9.4）。 */
function loadSettings(raw: Database.Database): Settings {
  const stored: Record<string, unknown> = {};
  try {
    const rows = raw.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const r of rows) {
      try {
        stored[r.key] = JSON.parse(r.value);
      } catch {
        // 单条值损坏只丢这一条，不影响其余设置
      }
    }
  } catch {
    // settings 表不存在等异常：用默认值
  }
  return sanitizeSettings(stored as Partial<Settings>);
}

/**
 * 当前 schema 版本（PRAGMA user_version 的值）。
 * v4 = v1.0.0 ⑥ 标签 + 文件夹；v5 = v1.1.0 URL 预览缓存表 + items.phash。
 */
export const SCHEMA_VERSION = 5;

/**
 * v0.2.0 → v0.3.0 的 schema 迁移：重建两个唯一索引，把谓词补成 `AND deleted_at IS NULL`。
 *
 * 为什么用 PRAGMA user_version 而不是看索引是否存在：索引**存在但谓词是旧的**才是要修的状态，
 * 靠"存在性"判断会漏掉——这正是升级用户最可能踩的那条路径。
 *
 * 幂等性：整个迁移放在一个事务里，user_version 也随事务一起提交/回滚（实测），
 * 所以中途崩溃不会留下"版本已升但索引没改"的中间态；重复调用直接早退。
 */
function migrateTrashSchema(raw: Database.Database): void {
  const current = Number(raw.pragma('user_version', { simple: true }));

  if (current < SCHEMA_VERSION) {
    const tx = raw.transaction(() => {
      // DROP 再建：谓词是索引定义的一部分，SQLite 不支持原地改。
      raw.exec('DROP INDEX IF EXISTS idx_content_hash');
      raw.exec('DROP INDEX IF EXISTS idx_image_hash');
      raw.exec(UNIQUE_INDEX_SQL);
      // v0.5.0：老库（user_version=1）也要拿到 optimize_history。
      // SCHEMA_SQL 是幂等建表，理论上 openDb 已经建过；这里再跑一次是为了让
      // "版本升级"这件事本身带上表结构，而不是依赖它上面那句 exec 的成功。
      raw.exec(OPTIMIZE_HISTORY_SQL);
      // v0.6.0：片段库同理，老库要拿到这张表。
      raw.exec(SNIPPET_SQL);
      // v1.0.0 ⑥：整理文件夹同理。放在 ensureColumns 之后跑，items 的两列此时已补好。
      raw.exec(FOLDER_SQL);
      // v1.1.0：URL 预览缓存表。纯缓存表，没有依赖 items 的部分，放哪儿都行。
      // items.phash 由 ensureColumns 补（openDb 里它先于本函数执行）。
      raw.exec(URL_PREVIEW_SQL);
      backfillSearchIndex(raw);
      raw.pragma('user_version = ' + SCHEMA_VERSION);
    });
    tx();
    return;
  }

  // 版本已是新版但索引被外部删掉了（手工修库、备份恢复）：补建但不重复改谓词。
  // 这一步同时也是全新库拿到索引的地方（建表段故意不建，见 SCHEMA_SQL 注释）。
  raw.exec(UNIQUE_INDEX_SQL);
}

/**
 * 给已有活跃行回填 search_index。
 *
 * ★ 必须在 Node 里逐行算：拼音转换不是 SQL 能力，SQLite 里算不出来。
 *   只在迁移时跑一次（版本闸门挡住重复执行），老库的几千条也就是一次启动的代价。
 * ★ 只补**活跃**行：回收站行的检索列没人用，而它们可能很多。
 * ★ 不用逐行 UPDATE 事务包（外层已经是事务）——这里直接复用同一个连接。
 */
function backfillSearchIndex(raw: Database.Database): void {
  const rows = raw.prepare('SELECT id, content FROM items WHERE deleted_at IS NULL').all() as {
    id: string;
    content: string | null;
  }[];
  if (rows.length === 0) return;
  const upd = raw.prepare('UPDATE items SET search_index = ? WHERE id = ?');
  for (const row of rows) {
    upd.run(buildSearchIndex(row.content ?? ''), row.id);
  }
}

/** 旧库补列（本轮 schema 是新库，留一个最小自愈入口）。 */
function ensureColumns(raw: Database.Database): void {
  const cols = new Set(
    (raw.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
  );
  const wanted: [string, string][] = [
    ['truncated', 'INTEGER NOT NULL DEFAULT 0'],
    ['source', "TEXT NOT NULL DEFAULT 'clip'"],
    ['seq', 'INTEGER NOT NULL DEFAULT 0'],
    ['thumb_path', 'TEXT'],
    // v0.3.0：回收站时间戳与来源 exe 名。都允许 NULL —— 活跃行与"来源未知"都是 NULL。
    ['deleted_at', 'INTEGER'],
    ['source_app', 'TEXT'],
    // v0.6.0：文件路径 / 富文本 / 拼音检索列。都允许 NULL —— 老行与新写的纯文本行都是 NULL。
    ['file_paths', 'TEXT'],
    ['rich_html', 'TEXT'],
    ['search_index', 'TEXT'],
    // v1.0.0 ⑥ 智能整理：标签（JSON 数组串）与所属文件夹。都允许 NULL ——
    // "没有标签"与"未归类"本来就该是同一个 NULL，而不是空数组 / 空串。
    ['tags', 'TEXT'],
    ['folder_id', 'TEXT'],
    // v1.1.0：图片感知哈希。允许 NULL —— 非图片行与升级前的老图片行都没有它，
    // "算不出来"与"没有这一列"本来就该是同一个 NULL。
    ['phash', 'TEXT'],
  ];
  for (const [name, decl] of wanted) {
    if (!cols.has(name)) raw.exec(`ALTER TABLE items ADD COLUMN ${name} ${decl}`);
  }
  // ★ v1.0.0 ⑥ 的 folder_id 索引只能在这里建，不能写进 SCHEMA_SQL：
  //   老库的 items 表已经存在（CREATE TABLE IF NOT EXISTS 是空操作），此时列还没补，
  //   SCHEMA_SQL 里那句 CREATE INDEX 会抛 no such column: folder_id 直接起不来。
  //   这与文件顶部"两个唯一索引故意不建在建表段"是同一个坑。
  raw.exec('CREATE INDEX IF NOT EXISTS idx_items_folder ON items(folder_id)');
}
