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
import { filePathsSignature, readFilePaths } from './files';
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

/**
 * 富文本最多留多少字符。
 *
 * 够贴回一个网页片段（一屏文章），但不该把整个网页的 DOM 塞进库里：
 * 那些行既搜不到也用不上，只会把数据库撑大、把列表查询拖慢。
 */
export const RICH_HTML_MAX = 200_000;

export type SkipKind = 'skip-files' | 'skip-rich' | 'none';

/** 轻提示的种类：两类"跳过" + 一类"按来源排除"（不含 'none'，它从不需要提示）。 */
export type NoticeKind = 'skip-files' | 'skip-rich' | 'excluded';

/** 跳过时的轻提示文案（每类只提示一次）。 */
export const SKIP_NOTICE: Record<NoticeKind, string> = {
  // 文件列表现在会真的落库；提示只在"认出是文件却解不出路径"时出现。
  'skip-files': '检测到文件列表，但解不出可用的文件路径',
  'skip-rich': '只有 HTML、没有纯文本',
  excluded: '已跳过该来源应用的剪贴板内容',
};

/** 按来源排除时的文案（带上 exe 名，用户才知道是哪条规则生效了）。 */
export function excludedNotice(exe: string): string {
  return '已跳过 ' + exe + ' 的剪贴板内容';
}

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
  /** 上一批文件列表的签名（三者互斥：文本 / 图片 / 文件）。 */
  filesSig: string | null = null;

  reset(): void {
    this.text = null;
    this.imageSig = null;
    this.filesSig = null;
  }
}

/** 轮询器眼里"记录器"的最小形状（真正的实现是 recorder.ts 的 Recorder）。 */
export interface RecordSink {
  /** 与轮询器共享的"上次值"。 */
  readonly lastSeen: LastSeen;
  /** sourceApp 未知（助手不可用 / 超时 / 排除自身）时传 undefined，**绝不因此不记录**。 */
  recordText(text: string, sourceApp?: string, richHtml?: string): unknown;
  recordImage(img: NativeImageLike, sig?: string | null, sourceApp?: string): unknown;
  /** 复制文件：paths 是绝对路径列表（**绝对路径不出主进程**，落库只存计数与相对信息）。 */
  recordFiles(paths: string[], sig?: string | null, sourceApp?: string): unknown;
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

/** 有没有 text/html（忽略 `; charset=...` 后缀）。 */
export function hasHtmlFormat(formats: string[]): boolean {
  return lower(formats).some((f) => f.split(';')[0]!.trim() === 'text/html');
}

/** 有没有 text/uri-list（读它之前必须先问一句：别的格式下 readText() 是无关内容）。 */
export function hasUriListFormat(formats: string[]): boolean {
  return lower(formats).some((f) => f.split(';')[0]!.trim() === 'text/uri-list');
}

/**
 * 这一跳属于哪一类（纯函数）。
 *
 * - `text/uri-list` / `FileNameW` → `skip-files`（文件列表，**要采集**）；
 * - 含 `image/*` → `none`（图片优先级高于 html）；
 * - 含 `text/plain` → `none`；
 * - 只有 `text/html` 而无 `text/plain` → `skip-rich`（**也要采集**）；
 * - 其余（空剪贴板等）→ `none`。
 *
 * ★ v0.6.0 起 `skip-files` / `skip-rich` 都不再表示"丢弃"：这两类现在真的会落库，
 *   枚举值只为兼容旧调用点而保留。tick 里**不能**因为它们而 return。
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
  /** 轻提示（跳过文件列表 / 富文本、按来源排除；同类只回调一次）。 */
  onNotice?: (kind: NoticeKind, message: string) => void;
  /** 诊断日志出口，默认走 `writeWatcherTrace`。 */
  onTrace?: (message: string) => void;
  /**
   * 取前台窗口所属进程的 exe 文件名。**只在真的检测到剪贴板变化时才调用**
   * （每跳都问助手等于每 300ms 一次 IPC），缺省视为"来源未知"。
   */
  foregroundExe?: () => Promise<string | null>;
  /**
   * 被排除的来源应用（小写 exe 名列表）。命中即**整条丢弃**、不落库——
   * 这是给密码管理器留的闸门：密码明文一旦进了库就是永久的，删记录也不代表磁盘上没留下。
   *
   * 传取值函数而不是数组：设置页随时会改，快照会失效。
   */
  excludeApps?: () => string[];
  /**
   * 读剪贴板上的文件路径（原生助手）。**只有真的检测到文件格式时才会调用。**
   *
   * ★ 为什么不直接用 clip.readBuffer('FileNameW')：实测 Electron 37 读别的程序写的
   *   CF_HDROP 会返回空字节（has 是 true，readBuffer 却是 0 字节），只有原生助手能拿到
   *   全部路径。返回 null 表示"助手没答上来"（不可用/超时/剪贴板被占用），
   *   调用方要退回 Electron 的通道，**不能**当成"没有文件"。
   */
  readFiles?: () => Promise<string[] | null>;
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
  private readonly onNotice: ((kind: NoticeKind, message: string) => void) | undefined;
  private readonly onTrace: ((message: string) => void) | undefined;
  private readonly foregroundExe: (() => Promise<string | null>) | undefined;
  private readonly excludeApps: () => string[];
  private readonly readFiles: (() => Promise<string[] | null>) | undefined;
  /**
   * 正在等助手回文件列表。
   *
   * ★ 文件列表要比对文本多一次异步往返（IPC 到原生助手），而剪贴板里躺着一批文件时
   *   每 300ms 都会跳进 handleFiles。没有这个闸门就会并发起 N 条重复记录。
   */
  private filesPending = false;
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
    this.excludeApps = deps.excludeApps ?? (() => []);
    this.readFiles = deps.readFiles;
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

      // ★ 文件分支必须排在图片与文本**之前**：命中文件就整跳结束，
      //   否则那一串路径会被 handleText 当成一条纯文本再记一遍。
      // ★ 判定用 has() 而不是格式列表：Electron 写 FileNameW 之后 availableFormats()
      //   只报 text/uri-list（见 files.ts 文件头）。shouldSkipFormats 兜住"只写 uri-list"的程序。
      if (this.clip.has(FILE_NAME_FORMAT) || shouldSkipFormats(fmts) === 'skip-files') {
        this.handleFiles(fmts, suppressed);
        this.failures = 0;
        return;
      }
      // skip-rich 不再丢弃：有 text/html 就带着 HTML 一起记（见 handleText）。
      if (hasImageFormat(fmts)) {
        this.handleImage(fmts, suppressed);
        this.failures = 0;
        return;
      }
      if (hasTextFormat(fmts) || hasHtmlFormat(fmts)) {
        this.handleText(fmts, suppressed);
        this.failures = 0;
        return;
      }
      // 空剪贴板 / 只有我们认不出的格式：什么都不做
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
      seen.filesSig = null;
    }

    // 自己刚写进去的：只更新"上次值"，不入库
    if (suppressed) return;

    const img = probe.img ?? this.clip.readImage();
    if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return;
    this.enqueueRecord(async () => {
      const sourceApp = await this.resolveSourceApp();
      if (this.dropExcluded(sourceApp)) return;
      this.recorder.recordImage(img, probe.sig, sourceApp);
    });
  }

  /**
   * 复制文件（P0-1）。
   *
   * 只在真的变了才落库：同一批文件在剪贴板里躺着时，300ms 一跳会一直读到它。
   * 命中文件时 text / imageSig 一律清空——三者互斥，留着"上次是文本"的残留
   * 会让紧接着的一次复制文本被判成重复而丢掉。
   */
  private handleFiles(fmts: string[], suppressed: boolean): void {
    if (this.filesPending) {
      // 上一批还在等助手回包：这一跳先不重入。
      // ★ 但要把它这次的自我抑制标记留下来——丢掉的话，程序自己写进剪贴板的那批文件
      //   会在助手回包后被当成一次真实复制记进历史。
      if (suppressed) this.suppress = true;
      return;
    }
    const readFiles = this.readFiles;
    if (!readFiles) {
      this.processFiles(fmts, suppressed, null);
      return;
    }
    this.filesPending = true;
    void readFiles()
      .catch(() => null)
      .then((helperPaths) => {
        this.filesPending = false;
        // ★ 空数组按"没答上来"处理：助手在 OpenClipboard 失败时也回 []，
        //   而 has('FileNameW') 明明为真——那正是需要退到 Electron 通道的场合。
        const answered = Array.isArray(helperPaths) && helperPaths.length > 0 ? helperPaths : null;
        this.processFiles(fmts, suppressed, answered);
      });
  }

  /** handleFiles 的实际工作；helperPaths 为 null 表示助手没答上来（走 Electron 退路）。 */
  private processFiles(fmts: string[], suppressed: boolean, helperPaths: string[] | null): void {
    const seen = this.recorder.lastSeen;

    // 读字节失败（格式存在但被别的进程抢走）不该让整跳记成一次"剪贴板读取失败"：
    // 那种失败会每 300ms 累加一次，把 trace 刷成噪音。
    // ★ 助手已经给出路径时不再碰这条通道：实测它对别的程序写的 CF_HDROP 会返回空字节，
    //   白读一次只增加被抢占的概率。
    let fileNameW: Buffer | null = null;
    if (helperPaths === null && typeof this.clip.readBuffer === 'function') {
      try {
        fileNameW = this.clip.readBuffer(FILE_NAME_FORMAT) ?? null;
      } catch {
        fileNameW = null;
      }
    }
    // ★ 只有格式列表里真有 text/uri-list 才读文本：readText() 在纯文件剪贴板上
    //   可能拿到别的内容（某些程序顺手写一条纯文本），那会把无关文字当路径解。
    const uriList = hasUriListFormat(fmts) ? (this.clip.readText() ?? null) : null;
    const paths = readFilePaths({ formats: fmts, fileNameW, uriList, helperPaths });

    if (paths.length === 0) {
      // 认出是文件剪贴板却解不出路径（短名/坏字节/只有目录 URI）：保持原有轻提示，别静默。
      this.notice('skip-files');
      return;
    }

    const sig = filePathsSignature(paths);
    if (seen.filesSig === sig) return;
    seen.filesSig = sig;
    seen.text = null;
    seen.imageSig = null;

    if (suppressed) return;

    this.enqueueRecord(async () => {
      const sourceApp = await this.resolveSourceApp();
      if (this.dropExcluded(sourceApp)) return;
      this.recorder.recordFiles(paths, sig, sourceApp);
    });
  }

  private handleText(fmts: string[], suppressed: boolean): void {
    const seen = this.recorder.lastSeen;
    const text = this.clip.readText() ?? '';
    const richHtml = hasHtmlFormat(fmts) ? this.readRichHtml() : undefined;
    // 只有 HTML、没有纯文本时 text 为空，但 HTML 本身就是要记的东西。
    if (text.length === 0 && richHtml === undefined) return;
    if (text === seen.text) return;
    seen.text = text;
    seen.imageSig = null;
    seen.filesSig = null;
    if (suppressed) return;
    this.enqueueRecord(async () => {
      const sourceApp = await this.resolveSourceApp();
      if (this.dropExcluded(sourceApp)) return;
      this.recorder.recordText(text, sourceApp, richHtml);
    });
  }

  /** 读 text/html 原始字节（拿不到 / 空串 → undefined，调用方按"没有富文本"处理）。 */
  private readRichHtml(): string | undefined {
    if (typeof this.clip.readBuffer !== 'function') return undefined;
    try {
      const buf = this.clip.readBuffer('text/html');
      if (!buf || buf.length === 0) return undefined;
      const html = buf.toString('utf8');
      if (html.length === 0) return undefined;
      return html.length > RICH_HTML_MAX ? html.slice(0, RICH_HTML_MAX) : html;
    } catch {
      // 读不到富文本不影响纯文本记录
      return undefined;
    }
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

  /**
   * 这个来源应用被排除吗（纯比较，不做 IO）。
   *
   * 大小写不敏感：设置里存的是小写，但助手/旧数据可能给别的写法。
   */
  private isExcluded(sourceApp?: string): boolean {
    if (typeof sourceApp !== 'string') return false;
    const exe = sourceApp.trim().toLowerCase();
    if (exe.length === 0) return false;
    let list: string[];
    try {
      list = this.excludeApps() ?? [];
    } catch {
      // 设置读失败就当没配排除——宁可多记一条，也不要因为读设置失败把整条采集停掉。
      return false;
    }
    for (const item of list) {
      if (typeof item === 'string' && item.trim().toLowerCase() === exe) return true;
    }
    return false;
  }

  /**
   * 排除命中时给一次轻提示并返回 true（调用方据此放弃落库）。
   *
   * ★ 语义是**整条丢弃**，不是"记了但隐藏"：被排除应用的内容一旦入库就是永久的，
   *   删记录也不代表磁盘上没有残留，所以这条路径必须真的不写。
   */
  private dropExcluded(sourceApp?: string): boolean {
    if (!this.isExcluded(sourceApp)) return false;
    // 按"种类 + 应用名"去重：同一个密码管理器只提醒一次，换一个应用再提醒一次。
    this.notice('excluded', excludedNotice(sourceApp ?? ''), 'excluded:' + (sourceApp ?? '').toLowerCase());
    return true;
  }

  private notice(kind: NoticeKind, message?: string, dedupeKey?: string): void {
    const key = dedupeKey ?? kind;
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    try {
      this.onNotice?.(kind, message ?? SKIP_NOTICE[kind]);
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
