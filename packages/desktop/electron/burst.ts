/**
 * 连续复制检测（spec §7.5；计划 Task 9）。
 *
 * ★ 旧版语义必须照抄：2 秒内连续复制满 3 条**只做预选 + 提示**，
 *   **绝不自动合并**。真正合并在用户按 Ctrl+M 时发生
 *   （legacy/src/MainForm.cs TrackBurst 只把 id 收进 _burstIds，
 *   合并发生在 MainForm.cs MergeSelected，且由 Ctrl+M 触发）。
 * ★ 触发一次后进入"已提示"状态，后续复制继续收集但不再重复提示，
 *   直到 clear()（= 用户按了 Ctrl+M / 切换筛选 / 清空选择）。
 * ★ 本文件不 import electron：托盘气泡走窄接口，可在 Node 里单测。
 */

/** 连续复制的时间窗口（spec §7.5：2000ms）。 */
export const BURST_WINDOW_MS = 2000;
/** 触发预选所需的条数（spec §7.5：3 条）。 */
export const BURST_COUNT = 3;

export interface BurstNote {
  /** 本次是否刚刚触发（同一轮只触发一次）。 */
  triggered: boolean;
  /** 触发时应当被预选的条目 id（按复制先后顺序）。 */
  ids: string[];
}

export class BurstDetector {
  private readonly windowMs: number;
  private readonly count: number;
  private entries: { id: string; at: number }[] = [];
  private hinted = false;

  constructor(windowMs: number = BURST_WINDOW_MS, count: number = BURST_COUNT) {
    this.windowMs = windowMs;
    this.count = Math.max(2, count);
  }

  /**
   * 记一次复制。返回是否触发预选。
   * at 缺省用当前时间；显式传入便于测试。
   */
  note(id: string, at: number = Date.now()): BurstNote {
    if (typeof id !== 'string' || id.length === 0) return { triggered: false, ids: [] };
    const cutoff = at - this.windowMs;
    // ★ 边界含：正好 2 秒前的那条仍算同一串（旧版连续复制检测也是闭区间语义）。
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    this.entries.push({ id, at });
    if (this.hinted) return { triggered: false, ids: this.ids() };
    if (this.entries.length < this.count) return { triggered: false, ids: this.ids() };
    this.hinted = true;
    const ids = this.ids();
    // 只保留触发的那几条，避免后续被更早的条目污染预选集。
    this.entries = this.entries.slice(-this.count);
    return { triggered: true, ids };
  }

  /** 当前窗口内的 id（按先后顺序）。 */
  ids(): string[] {
    return this.entries.map((e) => e.id);
  }

  /** 是否已经提示过（同一轮不重复提示）。 */
  get isHinted(): boolean {
    return this.hinted;
  }

  /** 用户完成一次拼接 / 切换筛选 / 清空选择后调用。 */
  clear(): void {
    this.entries = [];
    this.hinted = false;
  }
}

/** 提示文案（面板可见时的提示条与托盘气泡共用一份，避免两处漂移）。 */
export function burstHintText(count: number): string {
  return '连续复制了 ' + count + ' 条，按 Ctrl+M 拼接';
}

/** 面板不可见时发一次托盘气泡；没有托盘就静默跳过（不假装）。 */
export interface BalloonTray {
  displayBalloon(options: { title: string; content: string }): void;
}

export function showBurstBalloon(tray: BalloonTray | null, count: number): boolean {
  if (!tray) return false;
  try {
    tray.displayBalloon({ title: '剪贴板酱', content: burstHintText(count) });
    return true;
  } catch {
    return false;
  }
}
