/**
 * 图片落盘与文件生命周期（spec §7.3）。
 *
 * 依赖 electron 的部分被压到**窄接口** `NativeImageLike` 里：单测可以注入假对象，
 * 不需要真的启动 Electron。真正的 NativeImage 结构上就能满足这个接口。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashBuffer, type Db } from './db';
import { planBudgetEviction, type ImagePathRow } from './images-policy';
import { IMAGES_DIR_NAME, THUMBS_DIR_NAME, toRelativePath } from './paths';

/** 原图长边上限：超过先等比缩放（spec §7.3）。 */
export const MAX_IMAGE_EDGE = 2560;
/** 缩略图长边（spec §7.3）。 */
export const THUMB_EDGE = 128;
/** 无 alpha 原图的 JPEG 质量。 */
export const JPEG_QUALITY = 80;

export interface Size {
  width: number;
  height: number;
}

export interface ResizeOptions {
  width?: number;
  height?: number;
  quality?: 'good' | 'better' | 'best';
}

/**
 * NativeImage 的**窄接口**：只声明我们用到的 5 个方法。
 * `hasAlpha` / `toBitmap` 是可选的：Electron 的 NativeImage 上没有 hasAlpha 属性，
 * 有 toBitmap 时我们从 BGRA 的 A 通道自己判；两个都没有时按"无 alpha"处理（走 JPEG）。
 */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): Size;
  resize(options: ResizeOptions): NativeImageLike;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
  /** 显式的 alpha 标记：布尔值，或（更贴近测试注入的）一个返回布尔的方法。 */
  hasAlpha?: boolean | (() => boolean);
  toBitmap?(): Buffer;
}

export interface SavedImage {
  /** 相对数据目录的相对路径（统一 `/`），如 `images/<id>.jpg`。 */
  image_path: string;
  /** 相对数据目录的相对路径，如 `thumbs/<id>.png`。 */
  thumb_path: string;
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
}

/** 文件删除的结果日志：失败只记录、不上抛、不回滚数据库。 */
export interface FileRemovalLog {
  removed: string[];
  failures: string[];
}

/** 等比缩放到"长边 = edge"，不放大（图比 edge 小就原样返回）。 */
function fitLongEdge(size: Size, edge: number): Size {
  const w = Math.max(0, Math.round(size.width));
  const h = Math.max(0, Math.round(size.height));
  const long = Math.max(w, h);
  if (long <= edge || long === 0) return { width: w, height: h };
  const scale = edge / long;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** 判断是否带 alpha：优先用显式的 hasAlpha，其次扫 BGRA 位图的 A 通道，最后保守判 false。 */
export function detectAlpha(img: NativeImageLike): boolean {
  if (typeof img.hasAlpha === 'function') return img.hasAlpha();
  if (typeof img.hasAlpha === 'boolean') return img.hasAlpha;
  if (typeof img.toBitmap === 'function') {
    try {
      const bmp = img.toBitmap();
      for (let i = 3; i < bmp.length; i += 4) {
        if (bmp[i] !== 255) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 把一张图片写进 `images/<id>.<jpg|png>` 与 `thumbs/<id>.png`。
 *
 * 规则（spec §7.3）：
 * - 长边 > 2560 → 先等比 resize；
 * - 无 alpha → toJPEG(80) 存 .jpg；有 alpha → toPNG() 存 .png；
 * - 缩略图一律 PNG，长边 128；
 * - 返回值里的路径是**相对数据目录的相对路径**，绝对路径不出主进程。
 *
 * @param dir 数据目录（`%APPDATA%\Clipchan`）。
 */
export function saveImage(dir: string, id: string, img: NativeImageLike): SavedImage {
  if (!img || typeof img.isEmpty !== 'function' || img.isEmpty()) {
    throw new Error('saveImage: 空图片');
  }

  const original = img.getSize();
  const scaled = fitLongEdge(original, MAX_IMAGE_EDGE);
  const working: NativeImageLike =
    scaled.width === Math.round(original.width) && scaled.height === Math.round(original.height)
      ? img
      : img.resize({ width: scaled.width, height: scaled.height, quality: 'best' });
  const size = working.getSize();
  const width = Math.max(0, Math.round(size.width));
  const height = Math.max(0, Math.round(size.height));

  const hasAlpha = detectAlpha(img);
  const ext = hasAlpha ? 'png' : 'jpg';
  const originalBuf = hasAlpha ? working.toPNG() : working.toJPEG(JPEG_QUALITY);

  const thumbSize = fitLongEdge({ width, height }, THUMB_EDGE);
  const thumbImg: NativeImageLike =
    thumbSize.width === width && thumbSize.height === height
      ? working
      : working.resize({ width: thumbSize.width, height: thumbSize.height, quality: 'best' });
  const thumbBuf = thumbImg.toPNG();

  const absImages = path.join(dir, IMAGES_DIR_NAME);
  const absThumbs = path.join(dir, THUMBS_DIR_NAME);
  mkdirp(absImages);
  mkdirp(absThumbs);

  const imagePath = path.join(absImages, id + '.' + ext);
  const thumbPath = path.join(absThumbs, id + '.png');
  fs.writeFileSync(imagePath, originalBuf);
  fs.writeFileSync(thumbPath, thumbBuf);

  return {
    image_path: toRelativePath(dir, imagePath),
    thumb_path: toRelativePath(dir, thumbPath),
    width,
    height,
    bytes: originalBuf.length,
    hasAlpha,
  };
}

/** 图片字节的哈希（去重键）。 */
export function hashImageBuffer(buf: Buffer | Uint8Array): string {
  return hashBuffer(buf);
}

/**
 * 删除若干相对路径对应的文件。
 * ★ 删除失败**只记日志**：数据库那边的删除已经提交，绝不因为文件删不掉就回滚（spec §7.3）。
 */
export function deleteImageFiles(
  dir: string,
  rels: (string | null | undefined)[],
  onLog: (message: string) => void = (m) => console.warn('[images] ' + m),
): { log: FileRemovalLog } {
  const log: FileRemovalLog = { removed: [], failures: [] };
  for (const rel of rels) {
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(dir, rel);
    try {
      fs.unlinkSync(abs);
      log.removed.push(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // 已经不在了，不算失败
      const msg = abs + ' —— ' + String(e);
      log.failures.push(msg);
      onLog('图片文件删除失败（已忽略）：' + msg);
    }
  }
  return { log };
}

/** 取一批 id 对应的图片文件相对路径（非图片记录会被忽略）。 */
function relPathsOf(db: Db, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const row = db.getImageRow(id);
    if (!row) continue;
    if (row.image_path) out.push(row.image_path);
    if (row.thumb_path) out.push(row.thumb_path);
  }
  return out;
}

/**
 * 硬删记录（purge）并同步删除原图与缩略图 —— **全仓唯一会删盘的删除入口**。
 *
 * ★ 软删家族（remove / clearUnpinned / clearAll / 上限淘汰）**绝不经过本文件**：
 *   它们只盖 `deleted_at`、不碰磁盘，文件留在原处，回收站才有东西可恢复。
 *   所以旧的 removeItemsWithFiles / clearUnpinnedWithFiles 已删除——软删根本不涉及文件，
 *   留着 "WithFiles" 这个名字（以及它顺带删盘的实现）就是在撒谎。
 *
 * ★ 顺序不能反：**先取相对路径再删行**，行一删路径就没了。
 * ★ 数据库删除先提交，文件删除失败只记日志（spec §7.3）：残留文件由下次启动的
 *   sweepOrphans 兜底，绝不因为文件删不掉就回滚数据库。
 */
export function purgeItemsWithFiles(
  db: Db,
  dir: string,
  ids: string[],
  onLog?: (message: string) => void,
): { removed: number; log: FileRemovalLog } {
  const rels = relPathsOf(db, ids);
  const removed = db.purge(ids);
  const { log } = deleteImageFiles(dir, rels, onLog);
  return { removed, log };
}

/**
 * 按磁盘预算淘汰：删到预算的 80% 以下，收藏图片不动（spec §7.3 的"删除三条路径"之三）。
 *
 * ★ 这一族**必须硬删**（计划 §1.1 点名的最易错处）：预算淘汰的目的就是腾磁盘，
 *   改成软删只会把行藏进回收站、文件一个字节没少，预算永远降不下来，下一跳又淘汰一批，
 *   最后整库都被塞进回收站。所以这里用 `db.purge` 而不是 `db.removeMany`。
 * ★ 回收站行也计入总量（文件确实还在盘上），但排序时**先被腾掉**——见 planBudgetEviction。
 */
export function enforceImageBudget(
  db: Db,
  dir: string,
  budgetBytes: number,
  onLog?: (message: string) => void,
): { evicted: string[]; removed: number; log: FileRemovalLog } {
  const all = db.allImageRows();
  const rows = all.map((r) => ({
    id: r.id,
    pinned: r.pinned,
    bytes: r.bytes ?? 0,
    created_at: r.created_at,
    // 回收站行优先腾：它们已经是"用户不要了"的东西，先删它们再动活跃记录。
    deletedAt: r.deleted_at,
  }));
  const evicted = planBudgetEviction(rows, budgetBytes);
  if (evicted.length === 0) return { evicted, removed: 0, log: { removed: [], failures: [] } };

  const byId = new Map(all.map((r) => [r.id, r] as const));
  const rels: string[] = [];
  for (const id of evicted) {
    const row = byId.get(id);
    if (row?.image_path) rels.push(row.image_path);
    if (row?.thumb_path) rels.push(row.thumb_path);
  }
  const removed = db.purge(evicted);
  const { log } = deleteImageFiles(dir, rels, onLog);
  return { evicted, removed, log };
}

/**
 * 回收站超限淘汰 + 删盘。
 *
 * ★ db 层的 `purgeTrashOverLimit()` 是裸 DELETE（它不认识文件系统），返回的 id 已经取不到
 *   路径了。所以这里**先按 id 记下回收站图片行的路径**，再让 db 删行，最后删文件。
 * ★ 只在"设置里把 trashLimit 调小"这类调用方**主动**触发的场景用；db 内部顺手触发的
 *   超限淘汰（remove / clearUnpinned / clearAll 之后）拿不到 id，残留文件由启动时的
 *   sweepOrphans 兜底（它只删"盘上有、库里没有"，回收站行仍在库里所以那些文件是安全的）。
 */
export function purgeTrashOverLimitWithFiles(
  db: Db,
  dir: string,
  onLog?: (message: string) => void,
): { removed: number; log: FileRemovalLog } {
  const paths = new Map<string, (string | null)[]>();
  for (const r of db.allImageRows()) {
    if (r.deleted_at === null) continue;
    paths.set(r.id, [r.image_path, r.thumb_path]);
  }
  const ids = db.purgeTrashOverLimit();
  if (ids.length === 0) return { removed: 0, log: { removed: [], failures: [] } };

  const rels: (string | null)[] = [];
  for (const id of ids) {
    const p = paths.get(id);
    if (p) rels.push(...p);
  }
  const { log } = deleteImageFiles(dir, rels, onLog);
  return { removed: ids.length, log };
}

/** 供上层复用的类型（避免直接 import images-policy）。 */
export type { ImagePathRow };
