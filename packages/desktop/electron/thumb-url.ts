/**
 * 缩略图自定义协议（`clipchan-img:`）。
 *
 * ★ 为什么需要它：库里只存**相对数据目录**的路径（spec §9.2，换机器/换用户名也能用），
 *   而渲染进程把 `thumbUrl` 直接塞进 `<img src>` 会被解析成
 *   `file://.../dist/thumbs/<id>.png` → 404 → 破图。
 *   所以主进程在 IPC 边界把相对路径翻译成自定义协议 URL，再由协议处理器按 dataDir
 *   解析回真实文件。index.html 的 CSP **早就**白名单了 `clipchan-img:`，这条链路本轮补齐。
 * ★ 本文件是**纯函数模块**（只用 node:path），不 import electron —— 这样能在 vitest 的
 *   node 环境里直接单测；Electron 侧的 scheme 注册与文件读取留在 main.ts。
 * ★ 只放行 `thumbs/` 前缀，且拒绝 `..` 与 NUL：原图目录不通过这个协议暴露。
 */
import * as path from 'node:path';
import { IMAGES_DIR_NAME, THUMBS_DIR_NAME, imagesDir, thumbsDir } from './paths';

/** 自定义协议名（与 index.html 的 CSP `img-src ... clipchan-img:` 对应）。 */
export const THUMB_SCHEME = 'clipchan-img';
/** URL 主机名固定为 thumb，用作「这条 URL 是缩略图」的标记。 */
export const THUMB_HOST = 'thumb';
/**
 * 原图主机名。
 *
 * ★ 与 thumb 分成两个主机而不是一个：协议处理器按 hostname 决定读哪个目录，
 *   缩略图与原图各有各的目录白名单，一条 URL 只能命中其中一个。
 */
export const IMAGE_HOST = 'image';

/** 相对路径 → 安全路径段；非法输入返回 null（空、含 `..`/`.`、含 NUL）。 */
function safeSegments(rel: string): string[] | null {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (rel.includes('\u0000')) return null;
  const parts = rel.split(/[\\/]+/).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p === '.' || p === '..') return null;
  }
  return parts;
}

/**
 * 相对路径 → `clipchan-img://thumb/thumbs/<id>.png`。
 * 非法输入返回 undefined —— 宁可不显示，也不给界面一个坏 URL。
 */
export function thumbUrlFor(relPath: string | null | undefined): string | undefined {
  if (typeof relPath !== 'string') return undefined;
  const parts = safeSegments(relPath);
  if (!parts) return undefined;
  if (parts[0] !== THUMBS_DIR_NAME) return undefined;
  // 必须还有文件名：`thumbs` 本身是目录，不是可读的图片。
  if (parts.length < 2) return undefined;
  return THUMB_SCHEME + '://' + THUMB_HOST + '/' + parts.map(encodeURIComponent).join('/');
}

/**
 * 协议 URL → 磁盘绝对路径。
 * 只接受 `clipchan-img://thumb/thumbs/...`，且解析结果必须落在 `<dataDir>/thumbs` 内；
 * 否则返回 null（协议处理器据此回 404）。
 */
export function resolveThumbRequest(url: string, dataDir: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== THUMB_SCHEME + ':') return null;
  if (parsed.hostname !== THUMB_HOST) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const parts = safeSegments(decoded.replace(/^\/+/, ''));
  if (!parts) return null;
  if (parts[0] !== THUMBS_DIR_NAME) return null;
  // 必须还有文件名：`thumbs` 本身是目录，不该被当成图片读。
  if (parts.length < 2) return null;
  const base = path.resolve(thumbsDir(dataDir));
  const abs = path.resolve(base, ...parts.slice(1));
  // ★ 双重防线：解析结果必须真的落在 thumbs 目录**内部**（不是目录本身）。
  if (!abs.startsWith(base + path.sep)) return null;
  return abs;
}

/**
 * 把 DTO 的 thumbUrl 从相对路径换成自定义协议 URL。
 * - 没有缩略图的 DTO 原样返回（保持引用相等，方便上层 memo 比较）；
 * - 已经是协议 URL 的原样返回（幂等）；
 * - 相对路径非法 → thumbUrl 置空（界面回落到占位图标，而不是破图）。
 */
/** 原图相对路径 → `clipchan-img://image/images/<id>.jpg`；非法输入返回 undefined。 */
export function imageUrlFor(relPath: string | null | undefined): string | undefined {
  if (typeof relPath !== 'string') return undefined;
  const parts = safeSegments(relPath);
  if (!parts) return undefined;
  if (parts[0] !== IMAGES_DIR_NAME) return undefined;
  if (parts.length < 2) return undefined;
  return THUMB_SCHEME + '://' + IMAGE_HOST + '/' + parts.map(encodeURIComponent).join('/');
}

/**
 * 协议 URL → 原图磁盘绝对路径；只接受 `clipchan-img://image/images/...`。
 * 与 resolveThumbRequest 同一套双重防线（目录前缀 + 解析结果必须落在目录内部）。
 */
export function resolveImageRequest(url: string, dataDir: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== THUMB_SCHEME + ':') return null;
  if (parsed.hostname !== IMAGE_HOST) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const parts = safeSegments(decoded.replace(/^\/+/, ''));
  if (!parts) return null;
  if (parts[0] !== IMAGES_DIR_NAME) return null;
  if (parts.length < 2) return null;
  const base = path.resolve(imagesDir(dataDir));
  const abs = path.resolve(base, ...parts.slice(1));
  if (!abs.startsWith(base + path.sep)) return null;
  return abs;
}

export function mapThumbUrl<T extends object>(dto: T): T {
  const rel = (dto as { thumbUrl?: unknown } | null | undefined)?.thumbUrl;
  if (typeof rel !== 'string' || rel.length === 0) return dto;
  if (rel.startsWith(THUMB_SCHEME + '://')) return dto;
  const url = thumbUrlFor(rel);
  if (!url) {
    // 非法相对路径：把 thumbUrl 整个去掉（不是置空字符串），界面据此回落占位图标。
    const next = { ...(dto as Record<string, unknown>) };
    delete next['thumbUrl'];
    return next as T;
  }
  return { ...(dto as Record<string, unknown>), thumbUrl: url } as T;
}
