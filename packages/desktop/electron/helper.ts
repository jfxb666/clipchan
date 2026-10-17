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

/**
 * 常驻助手客户端。
 *
 * 生命周期（§8.2）：懒启动；stdout 关闭即视为崩溃 → 标记不可用 → 下次需要时
 * **最多自动重启一次**，再失败就彻底关闭功能（不再反复重启）；dispose 发 QUIT，
 * 2 秒内没退就强杀。
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
  /** 已经用掉的自动重启次数（上限 1）。 */
  private restartsUsed = 0;
  private availableFlag: boolean;

  constructor(options: HelperClientOptions = {}) {
    this.exePath = options.exePath ?? defaultHelperExePath();
    this.spawnImpl = options.spawnImpl ?? ((exe, args) => spawn(exe, args, { windowsHide: true }));
    this.timeoutMs = options.timeoutMs ?? 3000;
    // 注入了假子进程工厂时不检查文件存在性（测试用）；
    // 真实 spawn 时 exe 不存在就诚实标不可用，绝不假装。
    this.availableFlag = options.spawnImpl ? true : existsSync(this.exePath);
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
      this.markDead();
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
   * 确保有一个活着的子进程。懒启动；崩溃后最多重启一次；再失败返回 null。
   */
  private ensureChild(): ChildProcess | null {
    if (this.disposed) return null;
    if (this.child) return this.child;
    if (this.spawnedOnce && this.restartsUsed >= 1) {
      // 已经重启过一次仍然不行：彻底放弃，不再反复重启（§8.2）。
      this.availableFlag = false;
      return null;
    }
    if (this.spawnedOnce) this.restartsUsed += 1;
    this.spawnedOnce = true;

    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.exePath, ['--serve']);
    } catch {
      this.availableFlag = false;
      return null;
    }
    this.child = child;
    this.availableFlag = true;
    this.stdoutBuffer = '';
    this.attach(child);
    return child;
  }

  private attach(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.consume(String(chunk));
    });
    // stdout 关闭 = 助手没了（崩溃检测的唯一可靠信号）。
    child.stdout?.on('close', () => this.markDead());
    child.stdout?.on('end', () => this.markDead());
    child.once('error', () => this.markDead());
    child.once('exit', () => this.markDead());
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

  /** 子进程没了：标记不可用、清掉当前子进程、让所有等待者拿到安全值。 */
  private markDead(): void {
    if (this.disposed) return;
    this.child = null;
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
