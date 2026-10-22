/**
 * 文件列表的读取与签名（复制文件时记录，P0-1）。
 *
 * ── 为什么读文件列表要用 has('FileNameW') 而不是 availableFormats() ──────────
 * 实测（Electron 37 / Windows）：`clipboard.writeBuffer('FileNameW', ...)` 之后
 * `availableFormats()` 只报 `text/uri-list`，但 `has('FileNameW') === true`、
 * `readBuffer('FileNameW')` 能原样读回 DROPFILES 字节。
 * 也就是说格式列表会**漏报** CF_HDROP：只看 availableFormats 的判定，会把复制文件
 * 当成一条纯文本记成"一堆路径串"。所以调用方必须先问 `has()`，再决定要不要读字节；
 * 本模块只负责"拿到字节之后怎么解"。
 *
 * 本文件不 import electron：纯字节处理，单测直接喂 Buffer。
 */
import { createHash } from 'node:crypto';
import { MAX_FILES, baseNameOf, filesDesc, parseDropFiles, parseUriList } from './dropfiles';

/** 读取文件列表需要的一切原始素材（都由调用方从剪贴板取好）。 */
export interface FileProbeInput {
  /** 当前剪贴板的格式列表（原样传进来，便于调用点自解释与排错）。 */
  formats: string[];
  /** `readBuffer('FileNameW')` 的原始字节（DROPFILES）。 */
  fileNameW?: Buffer | null;
  /** `readText()` 读到的 text/uri-list 文本。 */
  uriList?: string | null;
  /**
   * 原生助手 `FILES` 命令读到的路径（最高优先级）。
   *
   * ★ 为什么需要它：Electron 的 clipboard 读 CF_HDROP 不可靠 —— 实测同一份剪贴板数据，
   *   `has('FileNameW')` 是 true 但 `readBuffer()`/`read()` 全空，只有 C# 的
   *   `GetClipboardData(15)` + `DragQueryFileW` 能拿到全部路径。所以只要助手可用，
   *   就以它为准；null 表示"助手没答上来"，继续走下面两条退路（**不能**当成没有文件）。
   */
  helperPaths?: string[] | null;
}

/** 一次探测的结果：路径列表 + 与 imageSignature 同层级的粗判签名。 */
export interface FileProbe {
  paths: string[];
  sig: string;
}

/** 盘符绝对路径（C:\\x 或 C:/x）。 */
const ABS_DRIVE = /^[A-Za-z]:[\\/]/;
/** UNC 绝对路径（\\\\server\\share 或 \\\\?\\C:\\...）。 */
const ABS_UNC = /^\\\\/;

function isAbsoluteWindowsPath(p: string): boolean {
  return ABS_DRIVE.test(p) || ABS_UNC.test(p);
}

/**
 * 从剪贴板原始素材解出文件路径列表。
 *
 * - 先看原生助手读到的（唯一可靠的 CF_HDROP 通道）；
 * - 空则试 DROPFILES（FileNameW 是 Explorer 的原生格式，信息最全）；
 * - 再空则退回 text/uri-list（别的程序常常只写这个）；
 * - 去重（Windows 路径不区分大小写）、丢掉相对路径（无法定位到磁盘上哪一份）、
 *   上限 MAX_FILES（复制整个文件夹可能是几千个）。
 */
export function readFilePaths(input: FileProbeInput): string[] {
  const fromHelper = Array.isArray(input.helperPaths) ? input.helperPaths : [];
  const fromDrop = parseDropFiles(input.fileNameW ?? null);
  const raw =
    fromHelper.length > 0
      ? fromHelper
      : fromDrop.length > 0
        ? fromDrop
        : parseUriList(input.uriList ?? null);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    // 路径首尾空白在 Windows 文件名里非法，trim 掉只会修好数据，不会改坏它。
    const value = p.trim();
    if (!isAbsoluteWindowsPath(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/**
 * 文件列表的粗判签名：`files:` + 小写路径列表的 sha1。
 *
 * 与 imageSignature 同层级：轮询器拿它挡住"同一批文件每 300ms 重记一次"，
 * 不必每跳都走一遍落库路径。顺序不同视为不同的一批（用户重新复制的就是新的一批）。
 */
export function filePathsSignature(paths: string[]): string {
  const list = Array.isArray(paths) ? paths : [];
  if (list.length === 0) return '';
  const joined = list.map((p) => (typeof p === 'string' ? p : '')).join('\u0000');
  return 'files:' + createHash('sha1').update(joined.toLowerCase()).digest('hex');
}

/** 文件记录在列表里的一句话描述（与图片的「图片 700×400 · 38 KB」同一层级）。 */
export function describeFiles(paths: string[]): string {
  const list = Array.isArray(paths) ? paths : [];
  return filesDesc(list.length, baseNameOf(list[0] ?? ''));
}

/** 一步拿到路径与签名（轮询器用；两个纯函数各自也单独可测）。 */
export function probeFiles(input: FileProbeInput): FileProbe {
  const paths = readFilePaths(input);
  return { paths, sig: filePathsSignature(paths) };
}
