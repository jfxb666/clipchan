/**
 * CF_HTML（Windows 剪贴板原生格式 `HTML Format`）的解析。
 *
 * 为什么需要它：Electron 的 `clipboard.readHTML()` 只回**片段**（StartFragment..EndFragment），
 * 丢掉外层的 `<html><head><style>`。对网页片段够用，对 Office 不够 —— 实测把
 * Excel 复制出来的片段写回剪贴板，粘回 Excel 时表头加粗丢失（Bold=False）；
 * 写回完整的 StartHTML..EndHTML 文档则完整保留（Bold=True）。
 *
 * 格式（微软 spec "HTML Clipboard Format"）：
 *   Version:1.0\r\nStartHTML:0000000105\r\nEndHTML:0000002342\r\n
 *   StartFragment:0000001949\r\nEndFragment:0000002290\r\n\r\n<html>...
 * 偏移量是**字节**偏移，不是字符偏移 —— 必须切 Buffer 再解码，否则含中文时错位。
 */

/** 头部最多扫这么多字节：正常头部 < 200 字节，留足余量又不至于扫整个文档。 */
const HEADER_SCAN_BYTES = 4096;

interface Offsets {
  startHtml: number;
  endHtml: number;
  startFragment: number;
  endFragment: number;
}

/** 从头部文本里取一个偏移量；缺失或非法一律 -1。 */
function readOffset(header: string, key: string): number {
  const m = new RegExp(key + ':(-?\\d+)').exec(header);
  if (m === null) return -1;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

/**
 * 解析头部偏移量。
 *
 * 头部只在前 HEADER_SCAN_BYTES 字节里找：`StartHTML` 之后的内容可能含同名文字
 * （HTML 正文里出现 "StartFragment:" 字样），不设界会匹配错位置。
 */
export function parseCfHtmlOffsets(buf: Buffer | Uint8Array | null | undefined): Offsets | null {
  if (!buf || buf.length === 0) return null;
  const head = Buffer.from(buf.subarray(0, Math.min(buf.length, HEADER_SCAN_BYTES))).toString('latin1');
  if (!head.startsWith('Version:')) return null;
  const startHtml = readOffset(head, 'StartHTML');
  const endHtml = readOffset(head, 'EndHTML');
  const startFragment = readOffset(head, 'StartFragment');
  const endFragment = readOffset(head, 'EndFragment');
  if (startHtml < 0 && startFragment < 0) return null;
  return { startHtml, endHtml, startFragment, endFragment };
}

/** 按字节偏移切一段出来并解码；区间非法回空串。 */
function sliceBytes(buf: Buffer, from: number, to: number): string {
  if (from < 0 || to <= from || from >= buf.length) return '';
  const end = Math.min(to, buf.length);
  return buf.subarray(from, end).toString('utf8');
}

/**
 * 取出完整 HTML 文档（StartHTML..EndHTML）。
 *
 * 拿不到完整区间时退回片段（StartFragment..EndFragment），再拿不到回 null ——
 * 宁可少外壳也别把整段当 HTML 塞回去。
 */
export function parseCfHtml(buf: Buffer | Uint8Array | null | undefined): string | null {
  if (!buf || buf.length === 0) return null;
  const raw = Buffer.from(buf);
  const off = parseCfHtmlOffsets(raw);
  if (off === null) return null;
  const full = off.endHtml > off.startHtml ? sliceBytes(raw, off.startHtml, off.endHtml) : '';
  if (full.length > 0) return full;
  const frag = off.endFragment > off.startFragment ? sliceBytes(raw, off.startFragment, off.endFragment) : '';
  return frag.length > 0 ? frag : null;
}
