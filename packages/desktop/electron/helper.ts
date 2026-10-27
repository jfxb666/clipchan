/**
 * Clipchan 原生助手客户端（Electron 主进程侧）。
 *
 * 设计依据：docs/superpowers/specs/2026-10-15-clipchan-rebuild-design.md §7.2（助手协议）
 * 与 §8.2（生命周期）。助手是常驻进程（--serve），通过 stdin/stdout 行协议通信；
 * 一次性启动要 400ms 量级，用户按 Enter 等不起，所以必须常驻 + 预热。
 *
 * 本文件只负责：解析行、管理子进程、请求-响应配对、崩溃检测与最多一次自动重启。
 * 所有 Win32 判定（三层验证 / 提权 / 毛玻璃）都在助手进程内完成。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapHelperCode, type PasteResult } from '@clipchan/core';

/** 助手 stdout 一行的解析结果。畸形行一律 `{ kind: 'UNKNOWN', raw }`，绝不抛异常。 */
export type HelperMessage =
  | { kind: 'READY'; pid: number }
  | { kind: 'RESULT'; hwnd: number; code: number; note: string }
  | { kind: 'BLUR'; hwnd: number; code: number }
  | { kind: 'FG'; hwnd: number }
  | { kind: 'FGEXE'; hwnd: number; exe: string }
  | { kind: 'FILES'; paths: string[] }
  | { kind: 'FILESET'; code: number }
  | { kind: 'PONG'; tag: string }
  | { kind: 'UNKNOWN'; raw: string };

/** 纯十进制非负整数（句柄 / 结果码都按十进制传输）。 */
const DECIMAL = /^\d+$/;

/**
 * 解析助手的一行输出。纯函数：不读环境、不抛异常。
 *
 * 协议（逐字，见 §7.2）：
 *   READY pid=<进程号>
 *   RESULT <句柄> <码> <说明>
 *   BLUR <句柄> <码>
 *   FG <十进制句柄>
 *   FGEXE <十进制句柄> <exe名>   取不到时是 "FGEXE 0 -"
 *   FILES <json数组>            剪贴板上的文件路径，可能是 []
 *   FILESET <返回码>            写文件列表到剪贴板，0 成功
 *   PONG <标记>
 */
export function parseHelperLine(line: string): HelperMessage {
  const raw = line;
  // 容忍 CRLF 与首尾空白；但 raw 保留原始整行，便于排障。
  const trimmed = line.replace(/\r$/, '').trim();
  if (trimmed.length === 0) return { kind: 'UNKNOWN', raw };
  const parts = trimmed.split(/\s+/);
  const head = parts[0];
  switch (head) {
    case 'READY': {
      if (parts.length !== 2) return { kind: 'UNKNOWN', raw };
      const m = /^pid=(\d+)$/.exec(parts[1] ?? '');
      if (!m || !m[1]) return { kind: 'UNKNOWN', raw };
      return { kind: 'READY', pid: Number(m[1]) };
    }
    case 'RESULT': {
      // RESULT 至少要有 句柄 + 码 + 说明；说明可含空格，取剩余部分。
      if (parts.length < 4) return { kind: 'UNKNOWN', raw };
      const hwnd = parts[1];
      const code = parts[2];
      if (!hwnd || !code || !DECIMAL.test(hwnd) || !DECIMAL.test(code)) {
        return { kind: 'UNKNOWN', raw };
      }
      return { kind: 'RESULT', hwnd: Number(hwnd), code: Number(code), note: parts.slice(3).join(' ') };
    }
    case 'BLUR': {
      if (parts.length !== 3) return { kind: 'UNKNOWN', raw };
      const hwnd = parts[1];
      const code = parts[2];
      if (!hwnd || !code || !DECIMAL.test(hwnd) || !DECIMAL.test(code)) {
        return { kind: 'UNKNOWN', raw };
      }
      return { kind: 'BLUR', hwnd: Number(hwnd), code: Number(code) };
    }
    case 'FG': {
      if (parts.length !== 2) return { kind: 'UNKNOWN', raw };
      const hwnd = parts[1];
      if (!hwnd || !DECIMAL.test(hwnd)) return { kind: 'UNKNOWN', raw };
      return { kind: 'FG', hwnd: Number(hwnd) };
    }
    case 'FGEXE': {
      // ★ 严格三段。exe 名里带空格时（"My App.exe"）助手会发出 4 段，这里判 UNKNOWN
      //   而不是把名字截成 "My"——宁可没有来源，也不要记一个错的来源。
      if (parts.length !== 3) return { kind: 'UNKNOWN', raw };
      const hwnd = parts[1];
      const exe = parts[2];
      if (!hwnd || !exe || !DECIMAL.test(hwnd)) return { kind: 'UNKNOWN', raw };
      return { kind: 'FGEXE', hwnd: Number(hwnd), exe };
    }
    case 'FILES': {
      // ★ 不能用 parts.length === 2 判：路径里可以有空格（"C:\Program Files\a.txt"），
      //   所以按空白切分一定会切碎。这里只剥掉行首的 "FILES "，剩下的整段当 JSON 解。
      const rest = trimmed.slice('FILES'.length).trim();
      if (rest.length === 0) return { kind: 'UNKNOWN', raw };
      let parsed: unknown;
      try {
        parsed = JSON.parse(rest);
      } catch {
        return { kind: 'UNKNOWN', raw };
      }
      if (!Array.isArray(parsed)) return { kind: 'UNKNOWN', raw };
      const paths: string[] = [];
      for (const item of parsed) {
        if (typeof item === 'string') paths.push(item);
      }
      // 元素全不是字符串时说明协议对不上，宁可当畸形行。
      if (paths.length === 0 && parsed.length > 0) return { kind: 'UNKNOWN', raw };
      return { kind: 'FILES', paths };
    }
    case 'FILESET': {
      if (parts.length !== 2) return { kind: 'UNKNOWN', raw };
      const code = parts[1];
      if (!code || !DECIMAL.test(code)) return { kind: 'UNKNOWN', raw };
      return { kind: 'FILESET', code: Number(code) };
    }
    case 'PONG': {
      if (parts.length !== 2) return { kind: 'UNKNOWN', raw };
      const tag = parts[1];
      if (!tag) return { kind: 'UNKNOWN', raw };
      return { kind: 'PONG', tag };
    }
    default:
      return { kind: 'UNKNOWN', raw };
  }
}

/** 本模块所在目录（packages/desktop/electron）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 助手可执行文件的默认路径：packages/desktop/helper/dist/clipchan-helper.exe。 */
export function defaultHelperExePath(): string {
  return path.resolve(HERE, '..', 'helper', 'dist', 'clipchan-helper.exe');
}

/**
 * 打包后的助手路径：electron-builder 的 extraResources 把 exe 放在 resources 根下。
 *
 * ★ 本文件刻意不 import electron（helper.spec.ts 要在纯 Node 下跑），所以这里只接受
 *   调用方传进来的 resourcesPath，由 main.ts 决定用哪一支。
 */
export function packagedHelperExePath(resourcesPath: string): string {
  return path.join(resourcesPath, 'clipchan-helper.exe');
}

/** 子进程工厂，测试可注入假实现。 */
export type SpawnImpl = (exe: string, args: string[]) => ChildProcess;

export interface HelperClientOptions {
  /** 助手 exe 路径，默认 defaultHelperExePath()。 */
  exePath?: string;
  /** 子进程工厂（测试注入）；缺省用 node:child_process 的 spawn。 */
  spawnImpl?: SpawnImpl;
  /** 单条请求的响应超时，默认 3000ms。 */
  timeoutMs?: number;
}

/** 等待中的一条请求。 */
interface Waiter {
  match: (message: HelperMessage) => boolean;
  settle: (message: HelperMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** dispose 等待子进程退出的宽限（到点强杀）。 */
const DISPOSE_GRACE_MS = 2000;
/** 面板毛玻璃的默认 ABGR（半透明深色），调用方不传色值时用。 */
const DEFAULT_ABGR = 0xcc1a1a1a;
/** 自动重启次数上限（含指数退避），避免崩溃循环把 CPU 打满。 */
const MAX_RESTARTS = 5;
/** 重启退避的起始时长，按次数翻倍。 */
const RESTART_BACKOFF_BASE_MS = 200;
/** 重启退避的封顶时长（再久也不值得等，交给用户重启 App）。 */
const RESTART_BACKOFF_MAX_MS = 2000;
/** 子进程稳定存活超过这个时长就把重启计数归零（长命进程不该永久消耗额度）。 */
const STABLE_UPTIME_MS = 30_000;

/** 第 n 次重启前的冷却时长（指数退避，封顶）。 */
function restartBackoffMs(restartsUsed: number): number {
  if (restartsUsed <= 0) return 0;
  return Math.min(RESTART_BACKOFF_BASE_MS * 2 ** (restartsUsed - 1), RESTART_BACKOFF_MAX_MS);
}

/**
 * 常驻助手客户端。
 *
 * 生命周期（§8.2）：懒启动；stdout 关闭即视为崩溃 → 标记不可用 → 下次需要时
 * **自动重启（上限 MAX_RESTARTS 次，带指数退避）**，额度用尽才彻底关闭功能；
 * 子进程稳定存活超过 STABLE_UPTIME_MS 就把额度归零。dispose 发 QUIT，2 秒内没退就强杀。
 *
 * 降级必须诚实：exe 不存在时 available === false，所有方法返回安全值且不抛异常。
 */
export class HelperClient {
  private readonly exePath: string;
  private readonly spawnImpl: SpawnImpl;
  private readonly timeoutMs: number;

  private child: ChildProcess | null = null;
  private stdoutBuffer = '';
  private waiters: Waiter[] = [];
  private disposed = false;
  /** 是否已经成功走到过 spawn 这一步。 */
  private spawnedOnce = false;
  /** 已经用掉的自动重启次数（上限 MAX_RESTARTS）。 */
  private restartsUsed = 0;
  /** exe 是否根本不存在：此时任何重启都无意义，永远诚实降级。 */
  private readonly exeMissing: boolean;
  /** 上一次崩溃的时刻，用来算重启冷却。 */
  private lastCrashAt = 0;
  /** 当前子进程的 spawn 时刻，用来判定「稳定存活」并归零重启计数。 */
  private spawnedAt = 0;
  private availableFlag: boolean;

  constructor(options: HelperClientOptions = {}) {
    this.exePath = options.exePath ?? defaultHelperExePath();
    this.spawnImpl = options.spawnImpl ?? ((exe, args) => spawn(exe, args, { windowsHide: true }));
    this.timeoutMs = options.timeoutMs ?? 3000;
    // 注入了假子进程工厂时不检查文件存在性（测试用）；
    // 真实 spawn 时 exe 不存在就诚实标不可用，绝不假装。
    this.exeMissing = options.spawnImpl ? false : !existsSync(this.exePath);
    this.availableFlag = !this.exeMissing;
  }

  /** 助手当前是否可用。 */
  get available(): boolean {
    return this.availableFlag;
  }

  /**
   * 预热：提前把常驻进程拉起来并探活（§8.2：启动后 5 秒空闲预热）。
   * 永不抛异常；失败只是 available 变 false。
   */
  prewarm(): void {
    if (this.disposed) return;
    const child = this.ensureChild();
    if (!child) return;
    try {
      child.stdin?.write('PING prewarm\n');
    } catch {
      this.markDead(child);
    }
  }

  /**
   * 请求把剪贴板粘到指定窗口。句柄失效/提权等按 @clipchan/core 的码表映射。
   * 句柄允许 bigint（计划接口契约），协议上一律走十进制字符串。
   */
  paste(hwnd: number | bigint): Promise<PasteResult> {
    const fallback: PasteResult = { ok: false, reason: 'send-failed' };
    const handle = Number(hwnd);
    if (!Number.isSafeInteger(handle) || handle < 0) return Promise.resolve(fallback);
    return this.request(
      `PASTE ${handle}\n`,
      (m) => m.kind === 'RESULT' && m.hwnd === handle,
      fallback,
      (m) => (m.kind === 'RESULT' ? mapHelperCode(m.code) : fallback),
    );
  }

  /** 开关窗口毛玻璃。成功（助手码 0）返回 true，其余返回 false。 */
  blur(hwnd: number, on: boolean, abgr: number = DEFAULT_ABGR): Promise<boolean> {
    const abgrValue = abgr >>> 0;
    return this.request(
      `BLUR ${hwnd} ${on ? 1 : 0} ${abgrValue}\n`,
      (m) => m.kind === 'BLUR' && m.hwnd === hwnd,
      false,
      (m) => (m.kind === 'BLUR' ? m.code === 0 : false),
    );
  }

  /** 查询当前前台窗口句柄；失败返回 0。 */
  foreground(): Promise<number> {
    return this.request(
      'FG\n',
      (m) => m.kind === 'FG',
      0,
      (m) => (m.kind === 'FG' ? m.hwnd : 0),
    );
  }

  /**
   * 查前台窗口所属进程的 exe 文件名（只记文件名，如 `Code.exe`）。
   *
   * 助手取不到时（没有前台窗口 / 窗口失效 / 目标提权 / 助手不可用 / 超时）返回 null：
   * 调用方据此**不记来源**，但记录本身必须照常写入。
   */
  foregroundExe(): Promise<string | null> {
    return this.request<string | null>(
      'FGEXE\n',
      (m) => m.kind === 'FGEXE',
      null,
      // 助手用 "0 -" 表示"取不到"，与解析层的宽松保持分层：这里才决定它等价于 null。
      (m) => (m.kind === 'FGEXE' && m.hwnd > 0 && m.exe !== '-' ? m.exe : null),
    );
  }

  /**
   * 读剪贴板上的文件路径列表（CF_HDROP）。
   *
   * ★ 为什么走助手而不是 Electron 的 clipboard：实测同一份剪贴板数据，Electron 的
   *   has('FileNameW') 是 true 但 readBuffer()/read() 全空、availableFormats() 还谎报
   *   text/uri-list；同一时刻 C# 的 GetClipboardData(15) + DragQueryFileW 能拿到全部路径。
   *   也就是说"有没有文件"问 Electron 是可靠的，"有哪些文件"只能问这里。
   *
   * 助手不可用 / 超时 / 剪贴板被占用一律返回 null：调用方据此回退到其它通道，
   * 但**不能**把 null 当成"没有文件"。
   */
  readFiles(): Promise<string[] | null> {
    return this.request<string[] | null>(
      'FILES\n',
      (m) => m.kind === 'FILES',
      null,
      (m) => (m.kind === 'FILES' ? m.paths : null),
    );
  }

  /**
   * 把一批路径写成标准 CF_HDROP 放进剪贴板。成功返回 true。
   *
   * ★ 为什么写也必须走助手：Electron 的 clipboard.writeBuffer('FileNameW', buf) 注册出来的
   *   是**自定义格式**（EnumClipboardFormats 实测 id=49159、名字 FileNameW），根本不是标准
   *   CF_HDROP(15)。资源管理器 / WinForms 的 GetFileDropList() 一律读不到，表现就是
   *   "复制了文件记录但粘贴不出文件"。writeBuffer('CF_HDROP', ...) 同样只会注册一个
   *   同名自定义格式（实测 id=49962）。
   *
   * 助手不可用 / 超时 / 返回非 0 一律 false：调用方据此回退到 Electron 通道并提示用户。
   */
  writeFiles(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return Promise.resolve(false);
    // 单行 JSON：路径里有空格，不能按空白切分传参。
    return this.request<boolean>(
      'FILESET ' + JSON.stringify(paths) + '\n',
      (m) => m.kind === 'FILESET',
      false,
      (m) => m.kind === 'FILESET' && m.code === 0,
    );
  }

  /** 发 QUIT 优雅退出；2 秒内没退就强杀。幂等。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.availableFlag = false;
    this.settleAll(null);
    if (!child) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 进程可能已退出 */
        }
        finish();
      }, DISPOSE_GRACE_MS);
      child.once('exit', finish);
      child.once('error', finish);
      try {
        child.stdin?.write('QUIT\n');
      } catch {
        finish();
      }
    });
  }

  // ---- 内部实现 ----

  /**
   * 确保有一个活着的子进程。懒启动；崩溃后按指数退避自动重启，额度用尽才返回 null。
   */
  private ensureChild(): ChildProcess | null {
    if (this.disposed) return null;
    if (this.child) return this.child;
    if (this.exeMissing) {
      // exe 根本不存在：重启多少次都没用，直接诚实降级。
      this.availableFlag = false;
      return null;
    }
    if (this.spawnedOnce) {
      if (this.restartsUsed >= MAX_RESTARTS) {
        // 额度用尽：彻底放弃，不再反复重启（§8.2）。
        this.availableFlag = false;
        return null;
      }
      // ★ 冷却期内不 spawn：崩溃循环时每次调用都立即重启会把 CPU 打满。
      //   这里只是「这次暂时不可用」，不消耗额度，冷却一过就能自愈。
      if (Date.now() - this.lastCrashAt < restartBackoffMs(this.restartsUsed)) {
        this.availableFlag = false;
        return null;
      }
      this.restartsUsed += 1;
    }
    this.spawnedOnce = true;

    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.exePath, ['--serve']);
    } catch {
      this.availableFlag = false;
      this.lastCrashAt = Date.now();
      return null;
    }
    this.child = child;
    this.availableFlag = true;
    this.stdoutBuffer = '';
    this.spawnedAt = Date.now();
    this.attach(child);
    return child;
  }

  private attach(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.consume(String(chunk));
    });
    // stdout 关闭 = 助手没了（崩溃检测的唯一可靠信号）。
    child.stdout?.on('close', () => this.markDead(child));
    child.stdout?.on('end', () => this.markDead(child));
    child.once('error', () => this.markDead(child));
    child.once('exit', () => this.markDead(child));
  }

  /** 按换行切分并逐行解析；最后一段不完整的行留在缓冲区。 */
  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    const newlineAt = this.stdoutBuffer.lastIndexOf('\n');
    if (newlineAt < 0) return;
    const complete = this.stdoutBuffer.slice(0, newlineAt);
    this.stdoutBuffer = this.stdoutBuffer.slice(newlineAt + 1);
    for (const line of complete.split('\n')) {
      this.dispatch(parseHelperLine(line));
    }
  }

  /** 把一条消息交给第一个匹配的等待者。 */
  private dispatch(message: HelperMessage): void {
    if (message.kind === 'UNKNOWN') return;
    const index = this.waiters.findIndex((w) => w.match(message));
    if (index < 0) return;
    const waiter = this.waiters[index];
    if (!waiter) return;
    this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.settle(message);
  }

  private request<T>(
    line: string,
    match: (message: HelperMessage) => boolean,
    fallback: T,
    transform: (message: HelperMessage) => T,
  ): Promise<T> {
    if (this.disposed) return Promise.resolve(fallback);
    const child = this.ensureChild();
    if (!child) return Promise.resolve(fallback);
    return new Promise<T>((resolve) => {
      let waiter: Waiter;
      waiter = {
        match,
        settle: (message) => resolve(message ? transform(message) : fallback),
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(fallback);
        }, this.timeoutMs),
      };
      this.waiters.push(waiter);
      try {
        child.stdin?.write(line);
      } catch {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        resolve(fallback);
      }
    });
  }

  /**
   * 子进程没了：标记不可用、清掉当前子进程、让所有等待者拿到安全值。
   *
   * ★ 必须带着「是哪个子进程」：旧子进程迟到的 close/exit 不能误杀刚重启起来的新进程，
   *   否则重启次数越多越容易自杀。
   */
  private markDead(child: ChildProcess): void {
    if (this.disposed) return;
    if (this.child !== child) return;
    // 稳定跑够久说明这次崩溃是偶发，把重启额度还回去。
    if (this.spawnedAt > 0 && Date.now() - this.spawnedAt >= STABLE_UPTIME_MS) {
      this.restartsUsed = 0;
    }
    this.child = null;
    this.spawnedAt = 0;
    this.lastCrashAt = Date.now();
    this.availableFlag = false;
    this.settleAll(null);
  }

  private settleAll(message: HelperMessage | null): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.settle(message);
    }
  }
}
