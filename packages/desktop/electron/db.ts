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
  classify,
  previewOfImage,
  previewOfText,
  type ClipItemDTO,
  type Kind,
  type KindFilter,
  type ListQuery,
  type OptimizeHistoryEntry,
  type Settings,
} from '@clipchan/core';

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
  source_app   TEXT
);
CREATE INDEX IF NOT EXISTS idx_order ON items(pinned DESC, created_at DESC, seq DESC);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
${OPTIMIZE_HISTORY_SQL}
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
}

export interface Db {
  /** 底层句柄（测试与上层诊断用）。 */
  readonly raw: Database.Database;
  insertText(text: string, opts?: InsertTextOpts): InsertResult;
  insertImage(meta: ImageMeta, opts?: InsertImageOpts): InsertResult;
  list(q?: ListQuery): ClipItemDTO[];
  /** 与 list 同条件的总条数（分页时界面显示"共 N 条"）。 */
  count(q?: ListQuery): number;
  remove(id: string): ItemRow | null;
  removeMany(ids: string[]): ItemRow[];
  togglePin(id: string): boolean;
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
    case 'text': case 'link': case 'code': case 'path': case 'number': case 'image':
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
  const extra: Pick<ClipItemDTO, 'sourceApp' | 'deletedAt'> = {};
  if (row.source_app) extra.sourceApp = row.source_app;
  if (typeof row.deleted_at === 'number') extra.deletedAt = row.deleted_at;
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
  return {
    id: row.id,
    kind,
    preview: previewOfText(row.content ?? ''),
    createdAt: row.created_at,
    pinned,
    truncated: row.truncated === 1,
    source,
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
  all: ['text', 'link', 'code', 'path', 'number', 'image'],
  'text-group': ['text', 'path', 'number'],
  favorite: ['text', 'link', 'code', 'path', 'number', 'image'],
  text: ['text'],
  link: ['link'],
  code: ['code'],
  path: ['path'],
  number: ['number'],
  image: ['image'],
};

/**
 * 图片的"描述文案"——必须与 core 的 previewOfImage 逐字一致（spec §8.1）。
 * 这里由 SQL 现场拼出、**不落库**，图片行 content 为 NULL 所以不会和文本撞。
 */
const IMAGE_DESC_SQL =
  "('图片 ' || width || '×' || height || ' · ' || CAST(bytes / 1024 AS INTEGER) || ' KB')";

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
    where.push(`(content LIKE '%' || ? || '%' OR (kind = 'image' AND ${IMAGE_DESC_SQL} LIKE '%' || ? || '%'))`);
    params.push(term, term);
  }
  return { where: where.join(' AND '), params };
}

function buildListSql(q: ListQuery): { sql: string; params: unknown[] } {
  const { where, params } = buildWhere(q);

  const rawLimit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  const rawOffset = typeof q.offset === 'number' && Number.isFinite(q.offset) ? Math.floor(q.offset) : 0;
  const offset = Math.max(0, rawOffset);

  const sql =
    'SELECT * FROM items WHERE ' + where +
    ' ORDER BY pinned DESC, created_at DESC, seq DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return { sql, params };
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

  const api: Db = {
    raw,

    insertText(text: string, opts: InsertTextOpts = {}): InsertResult {
      if (typeof text !== 'string') throw new Error('insertText: text 必须是字符串');
      const cleaned = text.replace(/\0/g, '');
      if (cleaned.length === 0) throw new Error('insertText: 空文本不入库');

      let content = cleaned;
      let truncated = opts.truncated === true;
      if (content.length > TEXT_LIMIT) {
        content = content.slice(0, TEXT_LIMIT);
        truncated = true;
      }

      const hash = hashText(content);
      // ★ 去重只认活跃行：命中回收站里的行会刷新一条已删记录的排序，用户复制完什么都不出现。
      const hit = raw.prepare('SELECT id FROM items WHERE content_hash = ? AND deleted_at IS NULL').get(hash) as
        | { id: string }
        | undefined;
      if (hit) {
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
        `INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq, source_app)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, kind, content, hash, sourceToDb(opts.source), opts.pinned ? 1 : 0, truncated ? 1 : 0, createdAt, seq,
        sourceAppToDb(opts.sourceApp),
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
      raw.prepare(
        `INSERT INTO items (id, kind, content, content_hash, image_path, image_hash, thumb_path,
                            width, height, bytes, source, pinned, truncated, created_at, seq, source_app)
         VALUES (?, 'image', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        id, meta.imagePath, meta.hash, meta.thumbPath,
        Math.max(0, Math.round(meta.width)), Math.max(0, Math.round(meta.height)), Math.max(0, Math.round(meta.bytes)),
        source, pinned ? 1 : 0, createdAt, seq, sourceAppToDb(opts.sourceApp),
      );
      evictOverLimit();
      return { id, touched: false };
    },

    list(q: ListQuery = {}): ClipItemDTO[] {
      const { sql, params } = buildListSql(q);
      const rows = raw.prepare(sql).all(...params) as ItemRow[];
      return rows.map(rowToDto);
    },

    count(q: ListQuery = {}): number {
      const { where, params } = buildWhere(q);
      const row = raw.prepare('SELECT COUNT(*) AS n FROM items WHERE ' + where).get(...params) as
        | { n: number }
        | undefined;
      return row ? row.n : 0;
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

/** 当前 schema 版本（PRAGMA user_version 的值）。 */
export const SCHEMA_VERSION = 2;

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
      raw.pragma('user_version = ' + SCHEMA_VERSION);
    });
    tx();
    return;
  }

  // 版本已是新版但索引被外部删掉了（手工修库、备份恢复）：补建但不重复改谓词。
  // 这一步同时也是全新库拿到索引的地方（建表段故意不建，见 SCHEMA_SQL 注释）。
  raw.exec(UNIQUE_INDEX_SQL);
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
  ];
  for (const [name, decl] of wanted) {
    if (!cols.has(name)) raw.exec(`ALTER TABLE items ADD COLUMN ${name} ${decl}`);
  }
}
