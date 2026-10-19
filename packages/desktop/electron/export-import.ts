/**
 * zip 导出 / 导入（v0.3.0 数据安全计划 §3 T4）。
 *
 * ★ 为什么从 JSON 改成 zip：v0.2.0 的导出只写了一个 JSON，图片列里只有**相对路径**，
 *   换个机器导入回来全是破图 —— 备份包里没有图片本身。zip 能把原图一起带走。
 * ★ 为什么本文件不 import electron：dialog 由调用方（main.ts）以函数注入。
 *   这样「用户点了取消」这条路径能在 vitest 里真跑一遍，而不是靠读 main.ts 源码猜。
 * ★ 导入的取舍（对齐 migrate.ts 的既有风格）：
 *   - 坏条跳过并计数，不整体回滚（一个包里有几条脏数据不该让整次导入白做）；
 *   - 但**插入**在单事务里：数据库要么全进要么全不进，不留半截数据；
 *   - 绝不覆盖现有数据（重复 id / 重复哈希一律跳过）—— 用户明确要求
 *     「导入别人的包不覆盖现有数据」。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import type { ExportResult, ImportResult } from '@clipchan/core';
import { hashBuffer, hashText, TEXT_LIMIT, type Db, type ItemRow } from './db';
import { IMAGES_DIR_NAME, THUMBS_DIR_NAME, imageAbs } from './paths';

/** 备份包格式版本。v1 是旧的 JSON 导出（没有图片），这里只认 2。 */
export const EXPORT_VERSION = 2;
/** 包内清单文件名。 */
export const MANIFEST_NAME = 'manifest.json';
/** 包内清单的 app 标记。 */
export const EXPORT_APP = 'Clipchan';
/**
 * manifest.json 里的一条记录。
 *
 * ★ 字段是「语义字段」而不是数据库列名：包是给未来版本读的，
 *   image_path 这种**本机磁盘路径**在包里没有意义，所以换成 imageFile
 *   （相对 zip 根的路径）。
 * ★ 不带 deletedAt：回收站里的东西不进导出包 —— 导出是「我的有效历史」。
 */
export interface ExportManifestItem {
  id: string;
  kind: string;
  content: string | null;
  contentHash: string | null;
  /** zip 内原图路径，如 images/<id>.jpg；原图文件已丢失时为 null。 */
  imageFile: string | null;
  imageHash: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  pinned: boolean;
  source: 'capture' | 'merge';
  sourceApp: string | null;
  truncated: boolean;
  createdAt: number;
  seq: number;
}

export interface ExportManifest {
  app: string;
  version: number;
  exportedAt: string;
  items: ExportManifestItem[];
}

/** 导入的四类计数。missingImages 是 skippedInvalid 的子集，见 importZipFile 的说明。 */
export interface ImportCounts {
  imported: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  missingImages: number;
}

/** showSaveDialog 的返回形状（只取我们用的两个字段，避免依赖 electron 类型）。 */
export interface SavePick {
  canceled: boolean;
  filePath?: string;
}

/** showOpenDialog 的返回形状。 */
export interface OpenPick {
  canceled: boolean;
  filePaths: string[];
}

/** 把任意抛出物变成一行可读文案（Error 的 String() 会带 Error: 前缀，这里剥掉）。 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 默认文件名 clipchan-export-YYYYMMDD-HHmmss.zip（本地时间，用户一眼认得出是哪天的备份）。 */
export function exportFileName(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return 'clipchan-export-' + stamp + '.zip';
}

/**
 * 从文件名里取一个**安全的**扩展名（含点）。
 *
 * ★ 为什么不能直接用 path.extname 的结果：包是外部文件，条目名可以是任何东西
 *   （../../evil.exe、a.jpg.exe）。我们只把它当「用哪个后缀存原图」的提示，
 *   且只放行字母数字，其余一律回落到 fallback —— 目标文件名永远由我们按 id 拼，
 *   条目名绝不参与拼接，zip-slip 因此不可能发生。
 */
function safeExt(fileName: string, fallback: string): string {
  const raw = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(raw) ? raw : fallback;
}

/** 读文件；不存在 / 不是普通文件 / 读失败都返回 null（导出不该因为一个坏文件整体失败）。 */
function readIfFile(abs: string): Buffer | null {
  try {
    if (!fs.existsSync(abs)) return null;
    if (!fs.statSync(abs).isFile()) return null;
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

/** 源行 → 清单条目（imageFile 由 buildArchive 填，因为要看文件在不在盘上）。 */
function toManifestItem(row: ItemRow): ExportManifestItem {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    imageFile: null,
    imageHash: row.image_hash,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    pinned: row.pinned !== 0,
    source: row.source === 'merge' ? 'merge' : 'capture',
    sourceApp: row.source_app,
    truncated: row.truncated !== 0,
    createdAt: row.created_at,
    seq: row.seq,
  };
}


/**
 * 把活跃记录 + 原图/缩略图打成一个 AdmZip 对象。
 *
 * ★ 只导活跃行（deleted_at IS NULL）：回收站内容不属于「我的有效历史」。
 * ★ 图片文件缺失时该条仍然导出（文本内容照样有价值），只是 imageFile 置 null
 *   并把 missingImages 加一 —— 整体失败会让用户连文字都拿不回来。
 */
function buildArchive(
  db: Db,
  dataDir: string,
  now: number,
): { zip: AdmZip; manifest: ExportManifest; missingImages: number } {
  const rows = db.raw
    .prepare('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY created_at DESC, seq DESC')
    .all() as ItemRow[];

  const zip = new AdmZip();
  const files: { name: string; buf: Buffer }[] = [];
  const items: ExportManifestItem[] = [];
  let missingImages = 0;

  for (const row of rows) {
    const item = toManifestItem(row);

    if (row.image_path) {
      const buf = readIfFile(imageAbs(dataDir, row.image_path));
      if (buf) {
        // 包内文件名按 id 重拼（不用库里的文件名）：id 唯一，包内不会撞名。
        const name = IMAGES_DIR_NAME + '/' + row.id + safeExt(row.image_path, '.png');
        files.push({ name, buf });
        item.imageFile = name;
      } else {
        missingImages += 1;
      }
    }

    if (row.thumb_path) {
      const buf = readIfFile(imageAbs(dataDir, row.thumb_path));
      // 缩略图是可选的：缺失就跳过，不计数也不报错（导入端会按需回落）。
      if (buf) files.push({ name: THUMBS_DIR_NAME + '/' + row.id + '.png', buf });
    }

    items.push(item);
  }

  const manifest: ExportManifest = {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    items,
  };

  // 清单排在最前：解压出来第一眼就是它能读的说明。
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  for (const f of files) zip.addFile(f.name, f.buf);
  return { zip, manifest, missingImages };
}

/**
 * 导出到用户选的 zip 路径。
 *
 * ★ pickSave 由 main.ts 注入（真身是 dialog.showSaveDialog）。
 * ★ 用户取消 → { ok:false, cancelled:true }：既不是成功也不是失败，
 *   界面据此静默返回，**不弹「导出失败」**。
 */
export async function exportAllToZip(opts: {
  db: Db;
  dataDir: string;
  pickSave: (defaultFileName: string) => Promise<SavePick>;
  now?: number;
}): Promise<ExportResult> {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  let picked: SavePick;
  try {
    picked = await opts.pickSave(exportFileName(new Date(now)));
  } catch (e) {
    return { ok: false, reason: '保存对话框打不开：' + errText(e) };
  }
  if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };

  try {
    const built = buildArchive(opts.db, opts.dataDir, now);
    // 同步写：调用方是主进程 handler，写完才回结果，界面不会拿到「还没落盘」的路径。
    built.zip.writeZip(picked.filePath);
    return {
      ok: true,
      path: picked.filePath,
      items: built.manifest.items.length,
      missingImages: built.missingImages,
    };
  } catch (e) {
    return { ok: false, reason: '写入备份包失败：' + errText(e) };
  }
}


// ---------------- 导入 ----------------

/** 校验通过的清单条目。 */
interface ValidItem {
  id: string;
  kind: string;
  content: string | null;
  imageFile: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  pinned: boolean;
  source: 'capture' | 'merge';
  sourceApp: string | null;
  truncated: boolean;
  createdAt: number;
  seq: number;
}

/** 合法的文本类 kind（'image' 走另一条插入路径）。 */
const TEXT_KINDS = new Set(['text', 'link', 'code', 'path', 'number']);

function asInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

function asOptInt(v: unknown): number | null {
  const n = asInt(v);
  return n === null ? null : Math.max(0, n);
}

/**
 * 逐字段校验一条清单记录。
 *
 * ★ 不信任包里任何派生字段：哈希一律按**真实内容/字节**重算（包里写什么都可能是假的，
 *   而唯一索引必须按真实内容建，否则能靠伪造哈希把重复内容塞进库）。
 * ★ 返回原因串而不是抛异常：调用方拿它写警告日志，坏条只是被跳过。
 */
function parseItem(raw: unknown): { ok: true; item: ValidItem } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: '条目不是对象' };
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (id.length === 0) return { ok: false, why: '缺少 id' };
  if (id.length > 128) return { ok: false, why: 'id 过长' };

  const kind = typeof r.kind === 'string' ? r.kind : '';
  if (kind !== 'image' && !TEXT_KINDS.has(kind)) return { ok: false, why: 'kind 不认识：' + JSON.stringify(r.kind) };

  const createdAt = asInt(r.createdAt);
  if (createdAt === null) return { ok: false, why: 'createdAt 无法解析' };
  const seq = asInt(r.seq);
  if (seq === null) return { ok: false, why: 'seq 无法解析' };

  const source: 'capture' | 'merge' = r.source === 'merge' ? 'merge' : 'capture';
  const pinned = r.pinned === true;
  const truncated = r.truncated === true;
  const sourceApp = typeof r.sourceApp === 'string' && r.sourceApp.trim().length > 0 ? r.sourceApp.trim() : null;

  if (kind === 'image') {
    const imageFile = typeof r.imageFile === 'string' ? r.imageFile.trim() : '';
    if (imageFile.length === 0) return { ok: false, why: '图片条目缺少 imageFile' };
    return {
      ok: true,
      item: {
        id, kind, content: null, imageFile,
        width: asOptInt(r.width), height: asOptInt(r.height), bytes: asOptInt(r.bytes),
        pinned, source, sourceApp, truncated, createdAt, seq,
      },
    };
  }

  const content = typeof r.content === 'string' ? r.content.replace(/\u0000/g, '') : '';
  if (content.length === 0) return { ok: false, why: '文本条目 content 为空' };
  // 超长正文截断而不是丢弃：用户要的是内容回来，不是完美的字节还原。
  const cut = content.length > TEXT_LIMIT;
  return {
    ok: true,
    item: {
      id, kind,
      content: cut ? content.slice(0, TEXT_LIMIT) : content,
      imageFile: null,
      width: null, height: null, bytes: null,
      pinned, source, sourceApp,
      truncated: truncated || cut,
      createdAt, seq,
    },
  };
}

/** 包里某个条目的字节（找不到 / 解压失败都返回 null，由调用方计 missingImages）。 */
function readEntryBytes(zip: AdmZip, name: string): Buffer | null {
  if (name.length === 0) return null;
  try {
    const entry = zip.getEntry(name);
    if (!entry || entry.isDirectory) return null;
    const buf = zip.readFile(entry);
    return buf && buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}


/**
 * 解析一个 zip 包并写入数据库。
 *
 * ★ 返回结构而不是抛：manifest 坏了是**用户可解释的状态**（「这不是 Clipchan 的包」），
 *   不该变成一条 IPC 异常栈。真正的意外（磁盘满、库被锁）同样折成 reason 返回，
 *   因为此时事务已经回滚，没有任何半截数据留在库里。
 * ★ missingImages 是 skippedInvalid 的**子集**：图片条目缺文件时两条计数都加一，
 *   前者回答「有几张图没带过来」，后者回答「总共跳过了几条」。
 */
function importZipFile(opts: {
  db: Db;
  dataDir: string;
  zipPath: string;
  onWarning?: (message: string) => void;
}): { ok: true; counts: ImportCounts } | { ok: false; reason: string } {
  const warn = opts.onWarning ?? ((m: string): void => console.warn('[import] ' + m));
  const { db, dataDir } = opts;

  let zip: AdmZip;
  try {
    zip = new AdmZip(opts.zipPath);
  } catch (e) {
    return { ok: false, reason: '不是有效的 zip 文件：' + errText(e) };
  }

  const manifestEntry = zip.getEntry(MANIFEST_NAME);
  if (!manifestEntry || manifestEntry.isDirectory) {
    return { ok: false, reason: '压缩包里没有 ' + MANIFEST_NAME + '，这不是 Clipchan 的备份包' };
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(zip.readAsText(manifestEntry, 'utf8'));
  } catch (e) {
    return { ok: false, reason: MANIFEST_NAME + ' 不是合法 JSON：' + errText(e) };
  }
  const items = (manifestRaw as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) {
    return { ok: false, reason: MANIFEST_NAME + ' 里没有 items 数组' };
  }

  const counts: ImportCounts = { imported: 0, skippedDuplicate: 0, skippedInvalid: 0, missingImages: 0 };
  /** 本次已经落盘的文件：事务回滚时要把它们删掉，否则留下没人引用的图。 */
  const written: string[] = [];

  const idExists = db.raw.prepare('SELECT 1 AS x FROM items WHERE id = ?');
  const contentHashHit = db.raw.prepare('SELECT 1 AS x FROM items WHERE content_hash = ? AND deleted_at IS NULL');
  const imageHashHit = db.raw.prepare('SELECT 1 AS x FROM items WHERE image_hash = ? AND deleted_at IS NULL');
  const insertTextRow = db.raw.prepare(
    'INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq, source_app) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertImageRow = db.raw.prepare(
    'INSERT INTO items (id, kind, content, content_hash, image_path, image_hash, thumb_path, ' +
      'width, height, bytes, source, pinned, truncated, created_at, seq, source_app) ' +
      "VALUES (?, 'image', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
  );

  const run = db.raw.transaction(() => {
    for (const raw of items) {
      const parsed = parseItem(raw);
      if (!parsed.ok) {
        counts.skippedInvalid += 1;
        warn('跳过一条（' + parsed.why + '）');
        continue;
      }
      const it = parsed.item;

      // ★ id 冲突查**全表**（含回收站）：主键全局唯一，回收站里的行同样占着这个 id。
      if (idExists.get(it.id)) {
        counts.skippedDuplicate += 1;
        warn('跳过一条（id 已存在）：' + it.id);
        continue;
      }

      if (it.kind === 'image') {
        const buf = readEntryBytes(zip, it.imageFile ?? '');
        if (!buf) {
          counts.skippedInvalid += 1;
          counts.missingImages += 1;
          warn('跳过一条（包内图片缺失）：' + it.id + ' / ' + String(it.imageFile));
          continue;
        }
        // 哈希按**真实字节**重算：包里伪造的 imageHash 不能用来绕过唯一索引。
        const imageHash = hashBuffer(buf);
        if (imageHashHit.get(imageHash)) {
          counts.skippedDuplicate += 1;
          warn('跳过一条（图片内容已存在）：' + it.id);
          continue;
        }

        const relImage = IMAGES_DIR_NAME + '/' + it.id + safeExt(it.imageFile ?? '', '.png');
        const absImage = imageAbs(dataDir, relImage);
        fs.mkdirSync(path.dirname(absImage), { recursive: true });
        fs.writeFileSync(absImage, buf);
        written.push(absImage);

        // 缩略图可选：包里没有就留 NULL，界面回落到占位图标（不破图）。
        const thumbName = THUMBS_DIR_NAME + '/' + it.id + '.png';
        const thumbBuf = readEntryBytes(zip, thumbName);
        let relThumb: string | null = null;
        if (thumbBuf) {
          const absThumb = imageAbs(dataDir, thumbName);
          fs.mkdirSync(path.dirname(absThumb), { recursive: true });
          fs.writeFileSync(absThumb, thumbBuf);
          written.push(absThumb);
          relThumb = thumbName;
        }

        insertImageRow.run(
          it.id, relImage, imageHash, relThumb,
          it.width ?? 0, it.height ?? 0, it.bytes ?? buf.length,
          it.source, it.pinned ? 1 : 0, it.createdAt, it.seq, it.sourceApp,
        );
        counts.imported += 1;
        continue;
      }

      // 文本类：保留原 kind（导出时已算过；重算会把 number/link 之类的分类改掉）。
      const contentHash = hashText(it.content ?? '');
      if (contentHashHit.get(contentHash)) {
        counts.skippedDuplicate += 1;
        warn('跳过一条（内容已存在）：' + it.id);
        continue;
      }
      insertTextRow.run(
        it.id, it.kind, it.content, contentHash,
        it.source, it.pinned ? 1 : 0, it.truncated ? 1 : 0, it.createdAt, it.seq, it.sourceApp,
      );
      counts.imported += 1;
    }
  });

  try {
    run();
  } catch (e) {
    // 事务已回滚：库里一条都没进。但文件删不回来，所以这里把本次写的删掉。
    for (const f of written) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // 删不掉也不该盖掉原始错误（启动时的孤儿扫描会兜底）。
      }
    }
    return { ok: false, reason: '导入事务失败，已整体回滚：' + errText(e) };
  }

  // ★ 这里不主动触发 historyLimit 淘汰：导入进来的条目被「悄悄踢进回收站」比超限更糟，
  //   后续任何一次正常复制都会触发淘汰，让它自然收敛。
  return { ok: true, counts };
}

/**
 * 从用户选的 zip 包导入。
 *
 * ★ pickOpen 由 main.ts 注入（真身是 dialog.showOpenDialog）。
 * ★ 用户取消 → { ok:false, cancelled:true }，不抛不报错。
 */
export async function importAllFromZip(opts: {
  db: Db;
  dataDir: string;
  pickOpen: () => Promise<OpenPick>;
  onWarning?: (message: string) => void;
}): Promise<ImportResult> {
  let picked: OpenPick;
  try {
    picked = await opts.pickOpen();
  } catch (e) {
    return { ok: false, reason: '打开对话框打不开：' + errText(e) };
  }
  const zipPath = picked.canceled ? undefined : picked.filePaths[0];
  if (!zipPath) return { ok: false, cancelled: true };

  const result = importZipFile({
    db: opts.db,
    dataDir: opts.dataDir,
    zipPath,
    ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, ...result.counts };
}

/** 导入汇总的界面文案（main.ts 的 toast 与测试共用一份，避免两处措辞漂移）。 */
export function importSummaryText(r: ImportResult): string {
  const parts: string[] = ['导入 ' + (r.imported ?? 0) + ' 条'];
  if ((r.skippedDuplicate ?? 0) > 0) parts.push('跳过重复 ' + r.skippedDuplicate + ' 条');
  if ((r.skippedInvalid ?? 0) > 0) parts.push('坏条 ' + r.skippedInvalid + ' 条');
  if ((r.missingImages ?? 0) > 0) parts.push('缺图 ' + r.missingImages + ' 条');
  return parts.join('，');
}

