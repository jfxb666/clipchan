/**
 * 图片落盘与文件生命周期（spec §7.3）。
 *
 * 依赖 electron 的部分被压到**窄接口** `NativeImageLike` 里：单测可以注入假对象，
 * 不需要真的启动 Electron。真正的 NativeImage 结构上就能满足这个接口。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dhash, rgbaToGray } from '@clipchan/core';
import { hashBuffer, type Db } from './db';
import { planBudgetEviction, type ImagePathRow } from './images-policy';
import { IMAGES_DIR_NAME, THUMBS_DIR_NAME, toRelativePath } from './paths';
import { bgraToRgba } from './qrcode';

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

/**
 * 一次像素解码，alpha 判定与感知哈希共用（T-M10）。
 * ★ 原来 detectAlpha 与 imagePhash 各自 img.toBitmap()：Electron 每次调用都会重新解一遍
 *   全图 BGRA，大图就是双份内存 + 双份 CPU。这里把"解码"收敛成一个出口，
 *   判定函数改成收 Buffer —— 判定规则一个字不动。
 */
export function pixelsOf(img: NativeImageLike): Buffer | null {
  if (!img || typeof img.toBitmap !== 'function') return null;
  try {
    const bmp = img.toBitmap();
    return Buffer.isBuffer(bmp) && bmp.length > 0 ? bmp : null;
  } catch {
    return null; // 解码失败与"没有这张图"同一处理：下游按无 alpha / 无 phash 走
  }
}

/** 扫 BGRA 位图的 A 通道（每像素第 4 字节）：有一个不是 255 就算带 alpha；空位图按无 alpha。 */
export function detectAlphaFrom(bmp: Buffer | null): boolean {
  if (!bmp || bmp.length === 0) return false;
  for (let i = 3; i < bmp.length; i += 4) {
    if (bmp[i] !== 255) return true;
  }
  return false;
}

/**
 * alpha 判定的统一实现：显式 hasAlpha > 扫位图 A 通道 > 保守 false。
 * ★ pixels 是调用方已解好的像素（T-M10 的复用通道）：undefined = 没解过，需要时现场解一次
 *   （detectAlpha 的原行为）；null = 解过了但失败，与空位图一样按无 alpha 走，不重试第二次。
 * ★ 抽出本函数而不是让 saveImage 直接调 detectAlpha(img)：后者拿不到共享像素，
 *   只能再解一遍码，T-M10 就白合并了。
 */
function detectAlphaOf(img: NativeImageLike, pixels?: Buffer | null): boolean {
  if (typeof img.hasAlpha === 'function') return img.hasAlpha();
  if (typeof img.hasAlpha === 'boolean') return img.hasAlpha;
  return detectAlphaFrom(pixels === undefined ? pixelsOf(img) : pixels);
}

/** 判断是否带 alpha：优先用显式的 hasAlpha，其次扫 BGRA 位图的 A 通道，最后保守判 false。 */
export function detectAlpha(img: NativeImageLike): boolean {
  return detectAlphaOf(img, undefined);
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
 * @param pixels 调用方已经解好的像素（pixelsOf 的产物，可选）：传了就不为判 alpha 再解一次。
 */
export function saveImage(
  dir: string,
  id: string,
  img: NativeImageLike,
  pixels?: Buffer | null,
): SavedImage {
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

  // ★ T-M10：recordImage 已为感知哈希解过一次像素，从这里传进来直接复用，不再二次解码；
  //   不传（main.ts 的截图路径等旧调用点）按需现场解，行为不变。alpha 优先级见 detectAlphaOf。
  const hasAlpha = detectAlphaOf(img, pixels);
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
 * 从一份已解码位图算 64 位 dHash（T-M10 起与 alpha 判定共用 pixelsOf 的那次解码）。
 *
 * ★ 尺寸由调用方给（本函数只认像素不认图）：dHash 要按行取梯度，光有字节推不出布局，
 *   所以签名是 (bmp, size)。size 不给 / 位图拿不到 / 算不出来都安静返回 undefined ——
 *   与"这张图没有感知哈希"同一处理，绝不影响入库。
 *
 * ★ 为什么和 hashImageBuffer 并存：sha256 判的是"字节完全相同"，缩放/重新压缩后的同一张图
 *   会被判成两张；dHash 判的是"视觉结构相近"，这正是"库里已有一张很相似的"要的语义。
 *   两者用途不同，缺一不可。
 * ★ 为什么复用 qrcode.ts 的 bgraToRgba：Electron 的 toBitmap() 给的是 **BGRA**，而
 *   rgbaToGray 要 RGBA。不换序时 R/B 互换，亮度（0.299R + 0.587G + 0.114B）会整体偏移，
 *   同一张图从剪贴板进来和从截图进来算出的哈希就对不上。换序逻辑已经有一份，
 *   再抄第三份只会让"哪份是对的"变成猜谜。
 * ★ 为什么返回 undefined 而不是空串：ImageMeta.phash 是可选的，不传就等于"这张图没有
 *   感知哈希"，db 层会整段跳过相似判定；传空串反而要多跑一次查询再判空。
 */
export function phashFrom(bmp: Buffer | null, size?: Size): string | undefined {
  try {
    if (!bmp || !size) return undefined;
    const width = Math.floor(size.width);
    const height = Math.floor(size.height);
    if (!(width > 0) || !(height > 0)) return undefined;

    const span = width * height * 4;
    // ★ 长度不够就不算：拿半张图算出的哈希是错的，而"错的相似判定"比"没有相似判定"更糟。
    if (bmp.length < span) return undefined;

    // ★ bgraToRgba 回的是 Uint8ClampedArray，而 rgbaToGray 收 Uint8Array —— 两者在 TS 里
    //   是不同的类型。不再 Uint8Array.from 拷一份（T-M10 磨掉的第三个全图拷贝），改用
    //   同一块内存的零拷贝视图：读字节两种视图语义一致（钳制只发生在写入侧），
    //   与 qrcode.ts 在 decode 通道间的互转是同一个做法。
    const rgba = bgraToRgba(bmp.subarray(0, span));
    const gray = rgbaToGray(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height);
    const hash = dhash(gray);
    return hash.length > 0 ? hash : undefined;
  } catch {
    // ★ 静默吞掉：这是入库前的**附属**计算，位图接口在异常图片上抛错是正常的，
    //   为此丢掉用户刚复制的图片才是真的错。
    return undefined;
  }
}

/**
 * v1.1.0：从 NativeImage 算 64 位 dHash；拿不到位图或算不出来返回 undefined（绝不影响入库）。
 * ★ T-M10：像素解码收敛到 pixelsOf，本函数只是"取尺寸 + 解码一次"的薄封装，
 *   外部调用点（recorder / main.ts 截图）签名不变。
 */
export function imagePhash(img: NativeImageLike): string | undefined {
  try {
    if (!img || typeof img.getSize !== 'function') return undefined;
    const size = img.getSize();
    // ★ 没有 toBitmap 就拿不到像素（只有 PNG/JPEG 字节，重新解码不值得）：
    //   算不出哈希不该让这张图入不了库，安静返回 undefined 即可。
    return phashFrom(pixelsOf(img), size);
  } catch {
    return undefined;
  }
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
  // ★ 先用聚合值判"要不要动手"（一条 SUM 查询，走 idx_image_bytes 覆盖索引），
  //   没超预算就到此为止 —— 绝大多数写入都属于这一档。T-B3 的第三次全量读行因此消失。
  // ★ 判定必须留在这里、不能挪到调用方：用户把预算调小之后，靠的就是"下一次写入"把它压下去
  //   （recorder.spec 钉着这条），所以任何 kinds 的写入都得来问一次。
  if (budgetBytes > 0 && db.imageBytesTotal() <= budgetBytes) {
    return { evicted: [], removed: 0, log: { removed: [], failures: [] } };
  }

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
