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
  type Settings,
} from '@clipchan/core';

/** 单条文本字符上限（抄 legacy/src/Store.cs:15 MaxChars）。 */
export const TEXT_LIMIT = 100000;

/** 列表默认每页条数 / 上限（spec §8.1）。 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** 库里的来源标记（spec §9.2 用的是 'clip'，core 的 DTO 用的是 'capture'）。 */
type DbSource = 'clip' | 'merge';

/** 建表 SQL —— ★ 逐字抄 spec §9.2，不要"顺手优化"。 */
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
  seq          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_hash ON items(content_hash) WHERE content_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_hash   ON items(image_hash)   WHERE image_hash   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order ON items(pinned DESC, created_at DESC, seq DESC);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  remove(id: string): ItemRow | null;
  removeMany(ids: string[]): ItemRow[];
  togglePin(id: string): boolean;
  clearUnpinned(): ItemRow[];
  clearAll(): number;
  getSettings(): Settings;
  setSettings(patch: Partial<Settings>): Settings;
  getRow(id: string): ItemRow | null;
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

/** 行 → 给界面看的投影。原图磁盘路径与哈希不出主进程（spec §8.1）。 */
function rowToDto(row: ItemRow): ClipItemDTO {
  const kind = toKind(row.kind);
  const pinned = row.pinned === 1;
  const source = sourceToDto(row.source);
  if (kind === 'image') {
    const w = row.width ?? 0;
    const h = row.height ?? 0;
    const bytes = row.bytes ?? 0;
    return {
      id: row.id,
      kind,
      preview: previewOfImage(w, h, bytes),
      thumbUrl: row.thumb_path ?? undefined,
      createdAt: row.created_at,
      pinned,
      sizeLabel: kbLabel(bytes),
      source,
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

function buildListSql(q: ListQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where: string[] = ['1 = 1'];

  const kinds = KIND_GROUPS[q.kind ?? 'all'] ?? KIND_GROUPS.all;
  where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
  params.push(...kinds);

  if ((q.kind ?? 'all') === 'favorite') where.push('pinned = 1');

  const term = typeof q.q === 'string' ? q.q.trim() : '';
  if (term.length > 0) {
    where.push(`(content LIKE '%' || ? || '%' OR (kind = 'image' AND ${IMAGE_DESC_SQL} LIKE '%' || ? || '%'))`);
    params.push(term, term);
  }

  const rawLimit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  const rawOffset = typeof q.offset === 'number' && Number.isFinite(q.offset) ? Math.floor(q.offset) : 0;
  const offset = Math.max(0, rawOffset);

  const sql =
    'SELECT * FROM items WHERE ' + where.join(' AND ') +
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
   */
  function evictOverLimit(): void {
    const limit = settingsCache.historyLimit;
    if (!Number.isFinite(limit) || limit <= 0) return;
    raw.prepare(
      `DELETE FROM items
        WHERE pinned = 0
          AND id NOT IN (
            SELECT id FROM items WHERE pinned = 0 ORDER BY created_at DESC, seq DESC LIMIT ?
          )`,
    ).run(Math.floor(limit));
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
      const hit = raw.prepare('SELECT id FROM items WHERE content_hash = ?').get(hash) as { id: string } | undefined;
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
        `INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, kind, content, hash, sourceToDb(opts.source), opts.pinned ? 1 : 0, truncated ? 1 : 0, createdAt, seq);
      evictOverLimit();
      return { id, touched: false };
    },

    insertImage(meta: ImageMeta, opts: InsertImageOpts = {}): InsertResult {
      if (!meta || typeof meta.hash !== 'string' || meta.hash.length === 0) {
        throw new Error('insertImage: 缺少 hash');
      }
      const hit = raw.prepare('SELECT id FROM items WHERE image_hash = ?').get(meta.hash) as { id: string } | undefined;
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
                            width, height, bytes, source, pinned, truncated, created_at, seq)
         VALUES (?, 'image', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        id, meta.imagePath, meta.hash, meta.thumbPath,
        Math.max(0, Math.round(meta.width)), Math.max(0, Math.round(meta.height)), Math.max(0, Math.round(meta.bytes)),
        source, pinned ? 1 : 0, createdAt, seq,
      );
      evictOverLimit();
      return { id, touched: false };
    },

    list(q: ListQuery = {}): ClipItemDTO[] {
      const { sql, params } = buildListSql(q);
      const rows = raw.prepare(sql).all(...params) as ItemRow[];
      return rows.map(rowToDto);
    },

    remove(id: string): ItemRow | null {
      const row = raw.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
      if (!row) return null;
      raw.prepare('DELETE FROM items WHERE id = ?').run(id);
      return row;
    },

    removeMany(ids: string[]): ItemRow[] {
      if (!ids || ids.length === 0) return [];
      const sel = raw.prepare('SELECT * FROM items WHERE id = ?');
      const del = raw.prepare('DELETE FROM items WHERE id = ?');
      const out: ItemRow[] = [];
      const tx = raw.transaction((list: string[]) => {
        for (const id of list) {
          const row = sel.get(id) as ItemRow | undefined;
          if (row) {
            del.run(id);
            out.push(row);
          }
        }
      });
      tx(ids);
      return out;
    },

    togglePin(id: string): boolean {
      const info = raw.prepare('UPDATE items SET pinned = CASE pinned WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
      return info.changes > 0;
    },

    clearUnpinned(): ItemRow[] {
      const rows = raw.prepare('SELECT * FROM items WHERE pinned = 0').all() as ItemRow[];
      raw.prepare('DELETE FROM items WHERE pinned = 0').run();
      return rows;
    },

    clearAll(): number {
      return raw.prepare('DELETE FROM items').run().changes;
    },

    getSettings(): Settings {
      return { ...settingsCache };
    },

    setSettings(patch: Partial<Settings>): Settings {
      const merged = sanitizeSettings({ ...settingsCache, ...(patch ?? {}) });
      const upsert = raw.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
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
  ];
  for (const [name, decl] of wanted) {
    if (!cols.has(name)) raw.exec(`ALTER TABLE items ADD COLUMN ${name} ${decl}`);
  }
}
