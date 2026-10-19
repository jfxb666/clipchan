/**
 * 剪贴板轮询（spec §7.1；计划 Task 5）。
 *
 * 每 300ms 一跳，**两级读取**——这是实测约束：`clipboard.readImage()` 遇到大图会把整张位图
 * 解码出来，300ms 一次足以把 CPU 吃满，所以先用格式 + 粗判签名挡一道。
 *
 * 三条纪律（漏一条就是 bug）：
 * 1. **幽灵模式彻底停止轮询**：`tick()` 第一行就 return，**完全不调用任何 `clipboard.*` API**
 *    ——这是对用户的隐私承诺（"这段时间剪贴板里出现过什么，程序真的不知道"）。
 * 2. **自我抑制**：程序自己写剪贴板之前调 `suppressNext()`，下一跳读到的内容只更新"上次值"、
 *    不入库（抄旧版 `legacy/src/MainForm.cs:811` 的 `_msg.SuppressNext()`）。
 * 3. **剪贴板被别的进程占用**：整跳包在 try/catch 里，失败即跳过本跳（**不学**旧版重试 3 次，
 *    300ms 后本来就有下一跳），连续失败 ≥5 次时按 `CLIPCHAN_TRACE` 惯例写日志。
 *
 * 本文件不 import electron：剪贴板走窄接口 `ClipboardLike`，测试里注入假对象即可。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NativeImageLike } from './images';

/** 轮询间隔（spec §7.1）。 */
export const POLL_INTERVAL_MS = 300;
/** 连续失败到这个次数才写一条 CLIPCHAN_TRACE 日志（spec §7.1）。 */
export const FAILURE_TRACE_THRESHOLD = 5;
/**
 * 取来源应用的等待上限。比助手自身的 3 秒默认超时短一个数量级：
 * 来源只是附加信息，不能让它拖住剪贴板记录。
 */
export const SOURCE_APP_TIMEOUT_MS = 500;
/** 图片粗判只看前 4KB（spec §7.1）。 */
export const IMAGE_SIG_HEAD_BYTES = 4096;
/** Windows 上"复制了文件"的剪贴板格式名（spec §7.1）。 */
export const FILE_NAME_FORMAT = 'FileNameW';

export type SkipKind = 'skip-files' | 'skip-rich' | 'none';

/** 跳过时的轻提示文案（每类只提示一次）。 */
export const SKIP_NOTICE: Record<'skip-files' | 'skip-rich', string> = {
  'skip-files': '检测到文件列表，本轮不记录文件',
  'skip-rich': '只有 HTML、没有纯文本，本轮不记录',
};

/**
 * 剪贴板窄接口：Electron 的 `clipboard` 结构上就满足它。
 *
 * `readBuffer` 是可选的（Electron 有 `clipboard.readBuffer`）：拿不到原始字节时退化为
 * "解码后取 PNG 字节当签名"，正确性不变、只是每跳多一次解码。
 */
export interface ClipboardLike {
  availableFormats(): string[];
  has(format: string): boolean;
  readText(): string;
  readImage(): NativeImageLike;
  readBuffer?(format: string): Buffer;
}

/**
 * "上次看到的值"——轮询器与记录器**共享同一份**。
 *
 * 启动基线与幽灵恢复都靠它：静默读一次、只更新这里、**不写库**（验收 27/28）。
 */
export class LastSeen {
  text: string | null = null;
  imageSig: string | null = null;

  reset(): void {
    this.text = null;
    this.imageSig = null;
  }
}

/** 轮询器眼里"记录器"的最小形状（真正的实现是 recorder.ts 的 Recorder）。 */
export interface RecordSink {
  /** 与轮询器共享的"上次值"。 */
  readonly lastSeen: LastSeen;
  /** sourceApp 未知（助手不可用 / 超时 / 排除自身）时传 undefined，**绝不因此不记录**。 */
  recordText(text: string, sourceApp?: string): unknown;
  recordImage(img: NativeImageLike, sig?: string | null, sourceApp?: string): unknown;
}

/**
 * 判定"这个 exe 就是我们自己"。命中时不记来源，否则面板内粘贴回写会写成
 * "来自 clipchan"，用户看到一条自我引用的历史。
 *
 * 同时认 electron.exe（开发期跑的是 Electron 本体）与 clipchan.exe /
 * clipchan-helper.exe（打包后与原生助手）。
 */
export function isSelfExe(exe: string | null | undefined): boolean {
  if (typeof exe !== 'string') return false;
  return SELF_EXE_NAMES.has(exe.trim().toLowerCase());
}

const SELF_EXE_NAMES: ReadonlySet<string> = new Set([
  'electron.exe',
  'clipchan.exe',
  'clipchan-helper.exe',
]);

function lower(formats: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const f of formats ?? []) {
    if (typeof f === 'string') out.push(f.toLowerCase());
  }
  return out;
}

/** 有没有 image/* 格式。 */
export function hasImageFormat(formats: string[]): boolean {
  return lower(formats).some((f) => f.startsWith('image/'));
}

/** 有没有 text/plain（忽略 `; charset=...` 后缀）。 */
export function hasTextFormat(formats: string[]): boolean {
  return lower(formats).some((f) => f.split(';')[0]!.trim() === 'text/plain');
}

/**
 * 这一跳要不要跳过（纯函数）。
 *
 * - `text/uri-list` / `FileNameW` → `skip-files`（文件列表，本轮不做）；
 * - 含 `image/*` → `none`（图片优先级高于 html）；
 * - 含 `text/plain` → `none`；
 * - 只有 `text/html` 而无 `text/plain` → `skip-rich`；
 * - 其余（空剪贴板等）→ `none`。
 */
export function shouldSkipFormats(formats: string[]): SkipKind {
  const list = lower(formats);
  if (list.some((f) => f === 'text/uri-list' || f.includes('filenamew') || f === 'filename')) {
    return 'skip-files';
  }
  if (list.some((f) => f.startsWith('image/'))) return 'none';
  if (list.some((f) => f.split(';')[0]!.trim() === 'text/plain')) return 'none';
  if (list.some((f) => f.split(';')[0]!.trim() === 'text/html')) return 'skip-rich';
  return 'none';
}

/**
 * 图片粗判签名：**格式列表 + 字节长度 + 前 4KB 的 sha1**。
 *
 * 刻意粗判：只改末尾一个字节（前 4KB 之外）签名不变——因为目的就是"别为此解码整张位图"，
 * 拿长度 + 开头 4KB 挡住绝大多数重复读取就够了（spec §7.1）。
 */
export function imageSignature(formats: string[], buf: Buffer | Uint8Array): string {
  const fmt = lower(formats).sort().join(',');
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const head = createHash('sha1').update(bytes.subarray(0, IMAGE_SIG_HEAD_BYTES)).digest('hex');
  return createHash('sha1').update(fmt + '|' + bytes.length + '|' + head).digest('hex');
}

/** 尽量拿到图片原始字节（不解码位图）。拿不到返回 null。 */
export function readImageBuffer(clip: ClipboardLike, formats: string[]): Buffer | null {
  if (typeof clip.readBuffer !== 'function') return null;
  const candidates: string[] = [];
  for (const f of formats ?? []) {
    if (typeof f === 'string' && /^image\//i.test(f)) candidates.push(f);
  }
  candidates.push('PNG', 'image/png');
  for (const c of candidates) {
    try {
      const b = clip.readBuffer(c);
      if (b && b.length > 0) return b;
    } catch {
      // 这个格式读不到，试下一个
    }
  }
  return null;
}

/**
 * 探测当前剪贴板里的图片：返回粗判签名（可能为 null）与"已经解码好的图"。
 *
 * - 有 `readBuffer`：**不解码**，签名来自原始字节，`img` 为 null（调用方按需再 `readImage()`）；
 * - 没有 `readBuffer`：解码一次，用 PNG 字节当签名，并把解好的图一并返回（不重复解码）。
 */
export function probeImage(
  clip: ClipboardLike,
  formats: string[],
): { sig: string | null; img: NativeImageLike | null } {
  const buf = readImageBuffer(clip, formats);
  if (buf) return { sig: imageSignature(formats, buf), img: null };
  try {
    const img = clip.readImage();
    if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return { sig: null, img: null };
    return { sig: imageSignature(formats, img.toPNG()), img };
  } catch {
    return { sig: null, img: null };
  }
}

/**
 * 诊断埋点：只有设了 `CLIPCHAN_TRACE` 才写，写 `%TEMP%\clipchan-watcher-trace.log`，
 * 全程 try/catch、绝不影响主流程（与 `legacy/src/MainForm.cs:868`、助手进程同一惯例）。
 */
export function writeWatcherTrace(message: string, dir: string = os.tmpdir()): void {
  if (!process.env.CLIPCHAN_TRACE) return;
  try {
    fs.appendFileSync(
      path.join(dir, 'clipchan-watcher-trace.log'),
      '[' + new Date().toISOString() + '] ' + message + '\n',
      'utf8',
    );
  } catch {
    // 埋点失败绝不冒泡
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 给一个 promise 加上限时：超时兑现 null。
 *
 * 被包裹的 promise 自己失败时**原样拒绝**——超时是"没等到"，失败是"取的时候炸了"，
 * 两者要能分开记日志，否则助手崩溃在 trace 里永远是一片安静。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface ClipboardWatcherDeps {
  clip: ClipboardLike;
  recorder: RecordSink;
  /** 幽灵模式门：返回 true 时 tick 第一行就 return（默认恒 false）。 */
  isGhostActive?: () => boolean;
  /** 轮询间隔，默认 300ms（测试可调小）。 */
  intervalMs?: number;
  /** 跳过文件列表 / 富文本时的轻提示（每类只回调一次）。 */
  onNotice?: (kind: 'skip-files' | 'skip-rich', message: string) => void;
  /** 诊断日志出口，默认走 `writeWatcherTrace`。 */
  onTrace?: (message: string) => void;
  /**
   * 取前台窗口所属进程的 exe 文件名。**只在真的检测到剪贴板变化时才调用**
   * （每跳都问助手等于每 300ms 一次 IPC），缺省视为"来源未知"。
   */
  foregroundExe?: () => Promise<string | null>;
}

/**
 * 剪贴板轮询器。
 *
 * `start()` 只是挂上定时器（不立刻跳一次）：调用方必须**先** `recorder.baseline()`
 * 建立"上次值"，再 `start()`，否则启动前就躺在剪贴板里的东西会被记成一条历史（验收 27）。
 */
export class ClipboardWatcher {
  private readonly clip: ClipboardLike;
  private readonly recorder: RecordSink;
  private readonly isGhostActive: () => boolean;
  private readonly intervalMs: number;
  private readonly onNotice: ((kind: 'skip-files' | 'skip-rich', message: string) => void) | undefined;
  private readonly onTrace: ((message: string) => void) | undefined;
  private readonly foregroundExe: (() => Promise<string | null>) | undefined;
  /** 记录串行链（见 enqueueRecord）。 */
  private recordChain: Promise<void> = Promise.resolve();
  /** 已提示过的跳过类别：第一次给一次轻提示，之后不再打扰。 */
  private readonly noticed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 一次性自我抑制标记（见文件头纪律 2）。 */
  private suppress = false;
  private failures = 0;

  constructor(deps: ClipboardWatcherDeps) {
    this.clip = deps.clip;
    this.recorder = deps.recorder;
    this.isGhostActive = deps.isGhostActive ?? (() => false);
    const ms = typeof deps.intervalMs === 'number' && deps.intervalMs > 0 ? deps.intervalMs : POLL_INTERVAL_MS;
    this.intervalMs = ms;
    this.onNotice = deps.onNotice;
    this.onTrace = deps.onTrace;
    this.foregroundExe = deps.foregroundExe;
  }

  /** 开始轮询（幂等）。 */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** 停止轮询（幂等）。幽灵模式期间由接线方调用。 */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * 自我抑制：**下一次** tick 无论读到什么都丢弃（只更新"上次值"）并清标记。
   *
   * 程序自己写剪贴板前必须先调它，否则自己的写入会被轮询捕获成新记录
   * （旧版 `MainForm.cs:811` 的 `_msg.SuppressNext()`）。
   */
  suppressNext(): void {
    this.suppress = true;
  }

  /** 连续失败次数（诊断 / 测试用）。 */
  get failureCount(): number {
    return this.failures;
  }

  /** 一跳。★ 第一行是幽灵门：幽灵模式期间不碰任何 clipboard API。 */
  private tick(): void {
    if (this.isGhostActive()) return;

    const suppressed = this.suppress;
    this.suppress = false;

    try {
      const fmts = this.readFormats();

      if (this.clip.has(FILE_NAME_FORMAT) || shouldSkipFormats(fmts) === 'skip-files') {
        this.notice('skip-files');
        this.failures = 0;
        return;
      }
      if (shouldSkipFormats(fmts) === 'skip-rich') {
        this.notice('skip-rich');
        this.failures = 0;
        return;
      }
      if (hasImageFormat(fmts)) {
        this.handleImage(fmts, suppressed);
        this.failures = 0;
        return;
      }
      if (hasTextFormat(fmts)) {
        this.handleText(suppressed);
        this.failures = 0;
        return;
      }
      // 空剪贴板 / 只有 html 且被上面挡掉等：什么都不做
      this.failures = 0;
    } catch (e) {
      this.failures += 1;
      if (this.failures >= FAILURE_TRACE_THRESHOLD && this.failures % FAILURE_TRACE_THRESHOLD === 0) {
        this.trace('剪贴板连续读取失败 ' + this.failures + ' 次：' + describeError(e));
      }
    }
  }

  private readFormats(): string[] {
    const f = this.clip.availableFormats();
    return Array.isArray(f) ? f : [];
  }

  private handleImage(fmts: string[], suppressed: boolean): void {
    const seen = this.recorder.lastSeen;
    const probe = probeImage(this.clip, fmts);

    if (probe.sig !== null) {
      // ★ 粗判相同 → 直接返回，**不调 readImage()**（这是本轮 CPU 约束的关键）
      if (probe.sig === seen.imageSig) return;
      seen.imageSig = probe.sig;
      seen.text = null;
    }

    // 自己刚写进去的：只更新"上次值"，不入库
    if (suppressed) return;

    const img = probe.img ?? this.clip.readImage();
    if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return;
    this.enqueueRecord(async () => {
      const sourceApp = await this.resolveSourceApp();
      this.recorder.recordImage(img, probe.sig, sourceApp);
    });
  }

  private handleText(suppressed: boolean): void {
    const seen = this.recorder.lastSeen;
    const text = this.clip.readText() ?? '';
    if (text.length === 0) return;
    if (text === seen.text) return;
    seen.text = text;
    seen.imageSig = null;
    if (suppressed) return;
    this.enqueueRecord(async () => {
      const sourceApp = await this.resolveSourceApp();
      this.recorder.recordText(text, sourceApp);
    });
  }

  /**
   * 记录排队执行。
   *
   * 取来源要问助手（一次 IPC 往返），必须异步；但两次复制如果并发落库就会乱序，
   * 所以串成一条链——任何一环失败都只吞掉自己，绝不断链。
   */
  private enqueueRecord(task: () => Promise<void>): void {
    this.recordChain = this.recordChain.then(task).catch((e: unknown) => {
      this.trace('记录管线失败（已忽略）：' + describeError(e));
    });
  }

  /** 当前排队中的记录全部完成时兑现（测试用；生产代码不需要等它）。 */
  whenRecordsSettled(): Promise<void> {
    return this.recordChain;
  }

  /**
   * 取来源应用名。**任何失败都返回 undefined**，调用方照常记录。
   *
   * 这里额外加一道比助手自身超时更短的闸：助手"活着但不回包"时，
   * 记录不能被它的 3 秒默认超时拖住。
   */
  private async resolveSourceApp(): Promise<string | undefined> {
    const probe = this.foregroundExe;
    if (!probe) return undefined;
    try {
      const exe = await withTimeout(probe(), SOURCE_APP_TIMEOUT_MS);
      if (typeof exe !== 'string' || exe.length === 0) return undefined;
      // 面板内粘贴回写会把前台判成自己，记下来就是一条自我引用。
      return isSelfExe(exe) ? undefined : exe;
    } catch (e) {
      this.trace('取来源应用失败（已忽略）：' + describeError(e));
      return undefined;
    }
  }

  private notice(kind: 'skip-files' | 'skip-rich'): void {
    if (this.noticed.has(kind)) return;
    this.noticed.add(kind);
    try {
      this.onNotice?.(kind, SKIP_NOTICE[kind]);
    } catch {
      // 提示失败不影响轮询
    }
  }

  private trace(message: string): void {
    try {
      (this.onTrace ?? writeWatcherTrace)(message);
    } catch {
      // 埋点失败绝不冒泡
    }
  }
}
