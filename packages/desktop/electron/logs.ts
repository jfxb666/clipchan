/**
 * 文件日志 + 崩溃钩子。
 *
 * ★ 为什么日志落在 <dataDir>/logs：设置页已经有「打开数据目录」，用户点一下就能把日志捞出来
 *   发给客服。换成 %TEMP% / app.getPath('logs') 都得为此新增一条 IPC 通道（并改 preload 契约），
 *   为一个纯诊断功能扩渲染层契约不划算。
 * ★ 本文件是**纯 Node 模块，不 import electron**：这样 vitest 能直接测，也让主进程之外
 *   （比如冒烟脚本）能复用同一套轮转逻辑。
 * ★ 所有写盘动作自己吞异常：日志失败绝不能把应用拖垮，也不该在崩溃钩子里二次抛出。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LogSinkOptions {
  dir: string;
  /** 单个文件上限，超过就轮转。默认 2MB。 */
  maxBytes?: number;
  /** 保留文件数（含正在写的 main.log）。默认 5。 */
  maxFiles?: number;
  /** 注入时钟，测试里用来断言时间戳格式。 */
  now?: () => number;
}

export interface LogSink {
  write(line: string): void;
  /** 当前写入的文件绝对路径（诊断 / 测试用）。 */
  path(): string;
  close(): void;
}

/** 崩溃钩子只需要"能挂监听"这一件事，所以用最小结构类型，不引 electron / node 的事件类型。 */
export interface CrashProc {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface CrashApp {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const MAIN_LOG_NAME = 'main.log';

/** 轮转后的名字：main.1.log、main.2.log …（序号越大越老）。 */
function rotatedName(index: number): string {
  return 'main.' + index + '.log';
}

/** 把任意抛出物压成一行可读文本；Error 优先用 stack（崩溃现场靠的就是它）。 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 建一个"追加一行、超限轮转"的同步日志槽。
 *
 * ★ 用 appendFileSync 而不是流：日志量本来就小（启动 + 少量 warn），同步写省掉了
 *   flush / 背压 / 进程退出丢尾巴这一整类问题，崩溃钩子里也更安全。
 */
export function createLogSink(opts: LogSinkOptions): LogSink {
  const dir = opts.dir;
  const maxBytes = opts.maxBytes !== undefined && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, Math.trunc(opts.maxFiles ?? DEFAULT_MAX_FILES));
  const now = opts.now ?? Date.now;
  const file = path.join(dir, MAIN_LOG_NAME);

  /**
   * 首次写失败后就放弃后续尝试。
   * ★ 没有这个标志，磁盘满 / 目录被占用的机器上每一行都会重试一次并再失败一次，
   *   日志系统自己变成刷屏源。
   */
  let failed = false;
  let closed = false;

  const currentSize = (): number => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };

  const rotate = (): void => {
    // 最老的直接丢，再把每个序号往后推一格（从老到新搬，避免覆盖）。
    try {
      fs.rmSync(path.join(dir, rotatedName(maxFiles - 1)), { force: true });
    } catch {
      /* 删不掉最老的也不该拦住新一轮写入 */
    }
    for (let i = maxFiles - 2; i >= 1; i--) {
      const from = path.join(dir, rotatedName(i));
      if (!fs.existsSync(from)) continue;
      try {
        fs.renameSync(from, path.join(dir, rotatedName(i + 1)));
      } catch {
        /* 单级失败就跳过，序号上留个洞不影响读取 */
      }
    }
    try {
      fs.renameSync(file, path.join(dir, rotatedName(1)));
    } catch {
      /* main.log 还不存在（第一次轮转）时无事可做 */
    }
  };

  return {
    write(line: string): void {
      if (failed || closed) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (currentSize() >= maxBytes) rotate();
        const text = '[' + new Date(now()).toISOString() + '] ' + line + '\r\n';
        fs.appendFileSync(file, text, 'utf8');
      } catch {
        failed = true;
      }
    },
    path(): string {
      return file;
    },
    close(): void {
      closed = true;
    },
  };
}

/**
 * 挂上进程级崩溃钩子。
 *
 * ★ uncaughtException 里**只记录、不退出**：托盘常驻应用直接 quit 会把用户当前那点上下文
 *   一起抹掉，而且 Electron 主进程在这个钩子里继续跑通常比退出更安全（真崩了系统还会再报）。
 * ★ render/child-process-gone 是渲染进程与助手子进程的死因，只有主进程收得到；
 *   没有这两条时，界面白屏在日志里连一行痕迹都不留。
 */
export function installCrashHooks(
  sink: LogSink,
  proc: CrashProc = process,
  app: CrashApp | null = null,
): void {
  proc.on('uncaughtException', (...args: unknown[]) => {
    sink.write('[crash] uncaughtException: ' + describeError(args[0]));
  });
  proc.on('unhandledRejection', (...args: unknown[]) => {
    sink.write('[crash] unhandledRejection: ' + describeError(args[0]));
  });
  if (!app) return;

  // ★ 两个事件的载荷形状一样（…, details），所以取最后一个参数当 details，少一份耦合。
  const gone = (label: string) => (...args: unknown[]) => {
    const details = args.length > 0 ? args[args.length - 1] : null;
    const d = (details ?? {}) as { reason?: unknown; exitCode?: unknown };
    sink.write(
      '[crash] ' + label + ': reason=' + String(d.reason) + ' exitCode=' + String(d.exitCode),
    );
  };
  app.on('render-process-gone', gone('render-process-gone'));
  app.on('child-process-gone', gone('child-process-gone'));
}
