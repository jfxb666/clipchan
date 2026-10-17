/**
 * 幽灵模式（spec §6.8 / §7.6；计划 Task 5）。
 *
 * 语义（与旧版一致、但实现更彻底）：
 * - **只存内存**，不写数据库（spec §7.6，旧版 `Settings.cs:18` 注释即如此），进程退出即失效；
 * - **彻底停止剪贴板轮询**，而不是"照读后丢弃"——这是隐私承诺：停止轮询意味着这段时间
 *   剪贴板里出现过什么，程序真的不知道；
 * - 代价必须诚实：幽灵期间用户主动复制的内容**不会**在结束后补录（因为根本没记录），
 *   恢复时给一次明确提示（验收 28）；
 * - 上限 720 分钟；`null` / `0` / 负数一律视为关闭（兼容 core 的 `set(0)` 与托盘菜单的 `set(null)`）。
 *
 * 本文件不 import electron：轮询器与记录器走窄接口，测试里注入假对象即可。
 */
import type { GhostState } from '@clipchan/core';

/** 幽灵模式时长上限（spec §6.8）。 */
export const GHOST_MAX_MINUTES = 720;
/** 恢复时的一次性提示（验收 28：明确告诉用户"期间内容未记录"）。 */
export const GHOST_RESUME_NOTICE =
  '幽灵模式已结束，剪贴板监听已恢复；期间复制的内容没有记录，也不会补录。';

/** 轮询控制器（真正的实现是 watcher.ts 的 ClipboardWatcher）。 */
export interface PollController {
  start(): void;
  stop(): void;
}

/** 启动基线（真正的实现是 recorder.ts 的 Recorder.baseline）。 */
export interface BaselineSource {
  /** 静默读一次剪贴板，只更新"上次值"、**不写库**。 */
  baseline(): void;
}

export interface GhostDeps {
  /** 幽灵开启时 `stop()`、恢复时 `start()`。 */
  watcher: PollController;
  /** 恢复前静默重置基线（不补录幽灵期间的内容）。 */
  recorder: BaselineSource;
  now?: () => number;
  /** 状态变化事件（开启 / 恢复 / 剩余时间变化），上层据此广播给 UI。 */
  onChange?: (state: GhostState) => void;
  /** 恢复时的一次性提示出口（默认不发声）。 */
  onResumeNotice?: (message: string) => void;
}

const OFF: GhostState = { active: false, remainingMs: 0, until: null };

/**
 * 幽灵模式状态机。
 *
 * 只做三件事：记 `until`、到点自动恢复、把状态变化通知出去。**不发 toast**——
 * 关闭提示由渲染层 store 统一负责（`packages/core/src/state/store.ts:410` 与 `:501`），
 * 主进程再发一次会重复。
 */
export class Ghost {
  private until: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly watcher: PollController;
  private readonly recorder: BaselineSource;
  private readonly nowFn: () => number;
  private readonly onChange: ((state: GhostState) => void) | undefined;
  private readonly onResumeNotice: ((message: string) => void) | undefined;
  private readonly listeners = new Set<(state: GhostState) => void>();

  constructor(deps: GhostDeps) {
    this.watcher = deps.watcher;
    this.recorder = deps.recorder;
    this.nowFn = deps.now ?? (() => Date.now());
    this.onChange = deps.onChange;
    this.onResumeNotice = deps.onResumeNotice;
  }

  /** 当前状态。到点未及恢复时顺手补一次自动恢复（定时器被系统挂起等极端情况）。 */
  get(): GhostState {
    if (this.until === null) return { ...OFF };
    const remainingMs = this.until - this.nowFn();
    if (remainingMs <= 0) {
      this.resume();
      return { ...OFF };
    }
    return { active: true, remainingMs, until: this.until };
  }

  /** 是否处于幽灵模式（轮询器每跳用它做第一道门）。 */
  isActive(): boolean {
    return this.until !== null && this.until > this.nowFn();
  }

  /**
   * 设置幽灵模式。
   *
   * `minutes` 为 `null` / `0` / 负数 / 非有限数 → 关闭；正数则钳到 720 分钟以内。
   * 重复开启会**重新计时**（用户在托盘里再选一次 30 分钟，就是从现在起再 30 分钟）。
   */
  set(minutes: number | null | undefined): GhostState {
    const mins = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.floor(minutes) : 0;
    if (mins <= 0) {
      this.resume();
      return { ...OFF };
    }
    const capped = Math.min(mins, GHOST_MAX_MINUTES);
    this.until = this.nowFn() + capped * 60_000;

    // 幽灵期间彻底停表（spec §6.8）：不是"读了再丢"
    this.watcher.stop();
    this.arm();
    const state = this.get();
    this.emit(state);
    return state;
  }

  /** 恢复监听：静默重置基线 → 再 start()（顺序不能反，否则会补录幽灵期间的内容）。 */
  resume(): void {
    if (this.until === null) return;
    this.until = null;
    this.clearTimer();
    this.silentReset();
    this.watcher.start();
    this.emit({ ...OFF });
    try {
      this.onResumeNotice?.(GHOST_RESUME_NOTICE);
    } catch {
      // 提示失败不影响恢复
    }
  }

  /** 注册状态变化监听，返回取消函数。 */
  onChanged(cb: (state: GhostState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 进程退出前清理定时器（`unref` 已保证它不会拖住退出，这里只是显式收口）。 */
  dispose(): void {
    this.clearTimer();
    this.until = null;
  }

  private silentReset(): void {
    try {
      this.recorder.baseline();
    } catch {
      // 基线读不到（剪贴板被占用）时轮询器会按"未知"处理，绝不因此卡住恢复
    }
  }

  private arm(): void {
    this.clearTimer();
    const remaining = (this.until ?? 0) - this.nowFn();
    if (remaining <= 0) return;
    // unref：幽灵定时器不能拖住进程退出
    this.timer = setTimeout(() => {
      this.timer = null;
      this.resume();
    }, remaining);
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(state: GhostState): void {
    try {
      this.onChange?.(state);
    } catch {
      // 广播失败不影响状态机
    }
    for (const cb of [...this.listeners]) {
      try {
        cb(state);
      } catch {
        // 单个监听器抛错不影响其它监听器
      }
    }
  }
}
