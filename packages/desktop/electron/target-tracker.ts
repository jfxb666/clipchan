/**
 * 面板粘贴的**目标窗口跟踪**（spec §7.2「目标窗口」与 §7.2 末段）。
 *
 * 设计依据（照抄旧版 `legacy/src/MainForm.cs:818-828` 的语义，见 `legacy/src/PastePolicy.cs`）：
 * - 自动粘贴的目标默认是**唤起面板那一刻**的前台窗口（旧版 `_preWindow`）；
 * - 句柄**一次性**：用过立刻清空，绝不复用。Windows 会回收并复用 HWND，
 *   陈旧句柄会让下一次粘贴钻进陌生窗口（旧版 `MainForm.cs:821-824` 的注释）；
 * - 小组件常驻 / 关掉「失焦隐藏」时，「唤起那一刻」早就过去了，所以要额外维护
 *   `lastForeignForeground`：面板显示时与面板失焦时各查一次前台窗口，
 *   结果**不是 Clipchan 自己**的 hwnd 才记下来；
 * - 目标 = 唤起时记下的句柄；为空或等于自身 hwnd 时回退到 lastForeignForeground；
 *   两者都不可用 → `null`（上层返回 `{ok:false, reason:'no-target'}`，诚实回退）。
 *
 * 本文件不 import electron，可被 vitest 直接单测。
 */

/** 前台窗口查询的窄接口（`HelperClient.foreground()` 结构上就满足）。 */
export interface ForegroundSource {
  foreground(): Promise<number>;
}

export interface TargetTrackerDeps {
  /** 前台窗口查询来源；缺省时 `notePanelShown` 退化为 no-op（助手不可用的降级路径）。 */
  foreground?: ForegroundSource;
}

/** 句柄是否是一个真实可用的窗口句柄（0 / 非整数 / 负数一律视为「没有」）。 */
function isHandle(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 目标窗口跟踪器：两个候选槽位，`consume()` **一次性消费**。
 *
 * 槽位：
 * - `pending`：唤起面板那一刻记下的前台窗口（旧版 `_preWindow`）；
 * - `lastForeign`：最近一次「不是 Clipchan 自己」的前台窗口（小组件 / 不隐藏场景用）。
 */
export class TargetTracker {
  private readonly foreground: ForegroundSource | null;

  private pending = 0;
  private lastForeignHwnd = 0;

  constructor(deps: TargetTrackerDeps = {}) {
    this.foreground = deps.foreground ?? null;
  }

  /**
   * 记下「唤起面板那一刻」的前台窗口。
   *
   * - 查不到（0 / 非法）→ 清空 pending（宁可没有目标，也不留陈旧句柄）；
   * - 等于自身 hwnd → 视为无目标（`PastePolicy.ShouldAttemptAutoPaste` 的
   *   `target == self` 分支：粘回自己面板毫无意义）。
   */
  noteForeground(hwnd: number, selfHwnd: number): void {
    if (!isHandle(hwnd)) {
      this.pending = 0;
      return;
    }
    if (isHandle(selfHwnd) && hwnd === selfHwnd) {
      this.pending = 0;
      return;
    }
    this.pending = hwnd;
  }

  /**
   * 面板显示 / 面板失焦时刷新 `lastForeignForeground`。
   *
   * 只在「查到了、且不是自己」时覆盖；查到的是自己或查询失败都保留上一次的值
   * （spec §7.2：结果不是 Clipchan 自己的 hwnd 就记下来）。
   * 永不抛异常 —— 助手不可用时只当作查不到。
   */
  async notePanelShown(selfHwnd: number): Promise<void> {
    const source = this.foreground;
    if (!source) return;
    let hwnd = 0;
    try {
      hwnd = Number(await source.foreground());
    } catch {
      return;
    }
    if (!isHandle(hwnd)) return;
    if (isHandle(selfHwnd) && hwnd === selfHwnd) return;
    this.lastForeignHwnd = hwnd;
  }

  /**
   * 取走本次粘贴的目标句柄（**一次性消费**）。
   *
   * 优先返回 pending，其次回退 lastForeign；无论返回哪个，**两个槽位一起清空**——
   * 保证「取过一次之后再取一定是 null」，杜绝任何陈旧句柄跨次复用（Review Focus 2）。
   */
  consume(): number | null {
    const pending = this.pending;
    const fallback = this.lastForeignHwnd;
    this.pending = 0;
    this.lastForeignHwnd = 0;
    if (isHandle(pending)) return pending;
    if (isHandle(fallback)) return fallback;
    return null;
  }

  /** 看一眼当前记下的外部前台窗口（只读，不清空）；没有则 null。 */
  lastForeign(): number | null {
    return isHandle(this.lastForeignHwnd) ? this.lastForeignHwnd : null;
  }
}
