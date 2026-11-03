/**
 * 最小性能观测面（审计 T-N8）。
 *
 * 装它的原因：看板里 T-B2 / T-B4 / T-M3 / T-M8 全都写着"需实测才能定级"，而当时代码里
 * 唯一的性能依据是注释手感（`main.ts` 的 9-18ms / 427ms、`db.ts` 的「几千条也就是一次启动的代价」），
 * 用户机器上到底哪一步在变慢，一点证据都拿不到。
 *
 * ★ 三条硬约束：
 *  1. 纯逻辑、时间源可注入 —— 仓库没有 jsdom，能脱离 Electron 单测的一律脱离。
 *  2. 汇报必须限流 —— 轮询是 300ms 一跳，不限流就是刷日志，日志本身反而变成新的卡顿源。
 *  3. 观测不能让主流程失败 —— 出口全程 try/catch，`observe` 不抛。
 */

/** 默认阈值：200ms。轮询上限是 300ms，超过这个数就说明那一跳真的挤占了下一跳。 */
export const DEFAULT_SLOW_THRESHOLD_MS = 200;
/** 同一标签两次汇报的最小间隔：1 分钟。慢是会被反复观察到的，不需要每分钟说一次。 */
export const DEFAULT_REPORT_INTERVAL_MS = 60_000;

export interface PerfWatchOptions {
  thresholdMs?: number;
  reportIntervalMs?: number;
  /** 汇报出口。主进程传"控制台 + 日志文件"双写；测试传数组收集。 */
  onReport?: (message: string) => void;
  /** 时间源，默认 Date.now（测试注入假表）。 */
  now?: () => number;
}

export interface PerfStat {
  label: string;
  /** 观察到的次数（不管快慢）。 */
  total: number;
  /** 超过阈值的次数。 */
  slow: number;
  /** 历史最慢一次的耗时。 */
  maxMs: number;
  /** 累计耗时，够算平均。 */
  sumMs: number;
}

export interface PerfWatch {
  observe(label: string, ms: number): void;
  stats(): PerfStat[];
  /** 一行一个标签的快照，给日志与冒烟读；空表返回空串。 */
  summary(): string;
  reset(): void;
}

/** 单个标签的状态。 */
interface Entry extends PerfStat {
  /** 上一次汇报出去的时刻，用来限流。 */
  lastReportAt: number | null;
}

export function createPerfWatch(opts: PerfWatchOptions = {}): PerfWatch {
  const threshold = Number.isFinite(opts.thresholdMs) && (opts.thresholdMs as number) > 0
    ? (opts.thresholdMs as number)
    : DEFAULT_SLOW_THRESHOLD_MS;
  const reportEvery = Number.isFinite(opts.reportIntervalMs) && (opts.reportIntervalMs as number) > 0
    ? (opts.reportIntervalMs as number)
    : DEFAULT_REPORT_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const onReport = opts.onReport ?? (() => {});

  const entries = new Map<string, Entry>();

  function entryOf(label: string): Entry {
    let e = entries.get(label);
    if (!e) {
      e = { label, total: 0, slow: 0, maxMs: 0, sumMs: 0, lastReportAt: null };
      entries.set(label, e);
    }
    return e;
  }

  return {
    observe(label, ms) {
      try {
        // 耗时必须是有限非负数：NaN（时间源被 mock 坏）或负数（时钟回拨）都不该污染统计
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
        const e = entryOf(label);
        e.total += 1;
        e.sumMs += ms;
        if (ms > e.maxMs) e.maxMs = ms;
        if (ms <= threshold) return;
        e.slow += 1;
        const at = now();
        if (e.lastReportAt !== null && at - e.lastReportAt < reportEvery) return;
        e.lastReportAt = at;
        onReport(
          '慢操作：' + label + ' 本次 ' + Math.round(ms) + 'ms（阈值 ' + threshold
            + 'ms，累计 ' + e.slow + '/' + e.total + ' 次超阈，最慢 ' + Math.round(e.maxMs) + 'ms，平均 '
            + Math.round(e.sumMs / e.total) + 'ms）',
        );
      } catch {
        // 观测本身绝不让被观测的流程失败
      }
    },

    stats() {
      return [...entries.values()].map((e) => ({
        label: e.label,
        total: e.total,
        slow: e.slow,
        maxMs: e.maxMs,
        sumMs: e.sumMs,
      }));
    },

    summary() {
      const rows = [...entries.values()].sort((a, b) => b.maxMs - a.maxMs);
      if (rows.length === 0) return '';
      return rows
        .map((e) => e.label + ' 次' + e.total + ' 慢' + e.slow + ' 最慢' + Math.round(e.maxMs) + 'ms')
        .join(' / ');
    },

    reset() {
      entries.clear();
    },
  };
}

/**
 * 一次调用的耗时（`now` 可注入，便于测试）。
 * ★ 只包同步函数：异步路径要计的是"用户等了多久"，那是调用方的事（见 recorder 里用法）。
 */
export function timed<T>(now: () => number, label: string, perf: PerfWatch, fn: () => T): T {
  const t0 = now();
  try {
    return fn();
  } finally {
    perf.observe(label, now() - t0);
  }
}
