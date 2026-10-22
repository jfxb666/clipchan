/**
 * Windows 剪贴板里的"文件列表"格式（CF_HDROP）编解码。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────
 * 读（复制文件时记录）和写（粘贴/拖出时还原）用的是**同一套字节布局**，
 * 两边各写一份必然走样。这里只做纯字节处理，不 import electron，
 * 所以可以被单测直接喂 Buffer。
 *
 * ── 布局（DROPFILES，20 字节头 + UTF-16LE 路径列表）────────────────────
 *   偏移 0   u32  pFiles   路径列表相对本结构的字节偏移（固定 20）
 *   偏移 4   i32  pt.x     拖放点，恒 0
 *   偏移 8   i32  pt.y     拖放点，恒 0
 *   偏移 12  u32  fNC      是否来自"网上邻居"，恒 0
 *   偏移 16  u32  fWide    1 = 路径是 UTF-16LE（0 = ANSI）
 *   偏移 20  ...            每条路径以一个 NUL 结尾，整个列表再补一个 NUL
 *
 * ★ 实测（Electron 37 / Windows）：clipboard.writeBuffer('FileNameW', buf) 写完，
 *   availableFormats() 只报 text/uri-list，但 has('FileNameW') === true、
 *   readBuffer('FileNameW') 能读回这段字节。所以判定必须用 has()，不能看格式列表。
 * ★ 系统回读出来可能是 8.3 短名（ADMINI~1），这是正常行为，不是解码错误。
 */

/** 头部长度：pFiles + pt(2×i32) + fNC + fWide。 */
const HEADER_BYTES = 20;

/** 单条路径的长度上限（防止一段坏字节把内存吃光）。 */
const MAX_PATH_CHARS = 4096;

/** 一次最多接受多少条文件（复制整个文件夹时可能是几千个）。 */
export const MAX_FILES = 500;

/** 从 DROPFILES 字节里解出路径列表；解不出来就返回空数组，绝不抛。 */
export function parseDropFiles(buf: Buffer | Uint8Array | null | undefined): string[] {
  if (!buf || buf.length < HEADER_BYTES) return [];
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const pFiles = view.readUInt32LE(0);
  const fWide = view.readUInt32LE(16);
  // 偏移落在头里或超出缓冲：坏数据，老实返回空。
  if (pFiles < HEADER_BYTES || pFiles >= view.length) return [];

  const out: string[] = [];
  if (fWide === 1) {
    let start = pFiles;
    while (start + 1 < view.length && out.length < MAX_FILES) {
      let end = start;
      while (end + 1 < view.length && view.readUInt16LE(end) !== 0) end += 2;
      if (end === start) break; // 空串 = 列表结束
      // 没有终止符的尾巴是坏数据（缓冲被截断）：丢掉它，不要把半截路径当文件。
      if (end + 1 >= view.length) break;
      const chars = Math.min(MAX_PATH_CHARS, (end - start) / 2);
      const text = view.toString('utf16le', start, start + chars * 2);
      if (text.length > 0) out.push(text);
      start = end + 2;
    }
  } else {
    // fWide = 0：老式 ANSI 列表（极少见，但 Explorer 之外的程序会写）。
    let start = pFiles;
    while (start < view.length && out.length < MAX_FILES) {
      let end = start;
      while (end < view.length && view[end] !== 0) end += 1;
      if (end === start) break;
      const text = view.toString('latin1', start, Math.min(end, start + MAX_PATH_CHARS));
      if (text.length > 0) out.push(text);
      start = end + 1;
    }
  }
  return out;
}

/** 从 text/uri-list 文本里解出路径（file:///C:/x/a.txt → C:\\x\\a.txt）；非文件 URI 丢掉。 */
export function parseUriList(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (raw.length === 0 || raw.startsWith('#')) continue;
    if (!raw.toLowerCase().startsWith('file:')) continue;
    let path = raw.slice(5).replace(/^\/\//, '');
    try {
      path = decodeURIComponent(path);
    } catch {
      // 百分号转义坏了就按原样用，不整条丢掉。
    }
    // file:///C:/x → /C:/x；file://server/share → UNC
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    else if (path.startsWith('/')) path = '\\\\' + path.slice(1).replace(/\//g, '\\');
    const normalized = path.replace(/\//g, '\\');
    if (normalized.length > 0) out.push(normalized);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/** 把路径列表编成 DROPFILES 字节（写回剪贴板 / 拖出时用）。 */
export function buildDropFiles(paths: string[]): Buffer {
  const list = paths.filter((p) => typeof p === 'string' && p.length > 0).slice(0, MAX_FILES);
  let bytes = 0;
  for (const p of list) bytes += Buffer.byteLength(p, 'utf16le') + 2;
  // 末尾的列表终止符：最后一条自己的 NUL + 一个额外 NUL
  const body = Buffer.alloc(bytes + 2);
  let offset = 0;
  for (const p of list) {
    offset += body.write(p, offset, 'utf16le');
    offset += 2; // 每条路径自己的终止符（write 不写 NUL，所以手动跳过 2 字节）
  }
  const head = Buffer.alloc(HEADER_BYTES);
  head.writeUInt32LE(HEADER_BYTES, 0); // pFiles
  head.writeUInt32LE(1, 16); // fWide = TRUE
  return Buffer.concat([head, body]);
}

/** 文件记录在列表里的"描述文案"（与图片的「图片 700×400 · 38 KB」同一层级）。 */
export function filesDesc(count: number, first?: string): string {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return '文件';
  const name = typeof first === 'string' && first.length > 0 ? first : '';
  const tail = n > 1 ? ' 等 ' + n + ' 个文件' : '';
  return name.length > 0 ? '文件 ' + name + tail : '文件 ' + n + ' 个';
}

/** 从绝对路径取文件名（描述文案与拖出提示都用它，绝对路径不出主进程）。 */
export function baseNameOf(p: string): string {
  if (typeof p !== 'string') return '';
  const parts = p.split(/[\\/]/);
  return parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
}
