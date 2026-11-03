import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_INTERVAL_MS,
  DEFAULT_SLOW_THRESHOLD_MS,
  createPerfWatch,
  timed,
} from './perf';

/**
 * 观测器的单测用**假时钟**：限流窗口的行为不能靠真等 60 秒来验。
 * 断言重点是"什么时候该出声、什么时候必须闭嘴"，而不是文案措辞。
 */
describe('createPerfWatch', () => {
  function harness(thresholdMs = 100, reportIntervalMs = DEFAULT_REPORT_INTERVAL_MS) {
    const lines: string[] = [];
    let t = 1_000_000;
    const perf = createPerfWatch({
      thresholdMs,
      reportIntervalMs,
      onReport: (m) => lines.push(m),
      now: () => t,
    });
    return { perf, lines, advance: (ms: number) => { t += ms; } };
  }

  it('默认阈值与限流窗口是常量（改它们要过这里）', () => {
    expect(DEFAULT_SLOW_THRESHOLD_MS).toBe(200);
    expect(DEFAULT_REPORT_INTERVAL_MS).toBe(60_000);
  });

  it('不超阈：不出声，但次数与耗时照样记账', () => {
    const { perf, lines } = harness();
    perf.observe('剪贴板轮询', 50);
    perf.observe('剪贴板轮询', 80);
    expect(lines).toEqual([]);
    const [s] = perf.stats();
    expect(s).toMatchObject({ label: '剪贴板轮询', total: 2, slow: 0, maxMs: 80, sumMs: 130 });
  });

  it('★ 超阈：出一行，且带上"本次/累计/最慢/平均"四个可判级的数', () => {
    const { perf, lines } = harness();
    perf.observe('写库', 250);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('慢操作：写库 本次 250ms');
    expect(lines[0]).toContain('阈值 100ms');
    expect(lines[0]).toContain('累计 1/1 次超阈');
    expect(lines[0]).toContain('最慢 250ms');
  });

  it('★ 限流：同一标签在窗口内再慢也不重复出声，但计数要继续走', () => {
    const { perf, lines } = harness();
    perf.observe('写库', 250);
    for (let i = 0; i < 20; i++) perf.observe('写库', 300);
    expect(lines).toHaveLength(1);
    expect(perf.stats()[0]).toMatchObject({ total: 21, slow: 21, maxMs: 300 });
  });

  it('★ 窗口过去之后允许再出声（长期变慢不能被永久静音）', () => {
    const { perf, lines, advance } = harness(100, 1000);
    perf.observe('写库', 250);
    perf.observe('写库', 250);
    expect(lines).toHaveLength(1);
    advance(1500);
    perf.observe('写库', 250);
    expect(lines).toHaveLength(2);
  });

  it('不同标签各自独立限流与计数', () => {
    const { perf, lines } = harness();
    perf.observe('写库', 250);
    perf.observe('轮询', 900);
    expect(lines).toHaveLength(2);
    expect(perf.stats().map((s) => s.label).sort()).toEqual(['写库', '轮询']);
  });

  it('脏耗时（NaN / 负数 / 非数字）不进统计，也不出声', () => {
    const { perf, lines } = harness();
    perf.observe('写库', Number.NaN);
    perf.observe('写库', -5);
    perf.observe('写库', undefined as unknown as number);
    expect(lines).toEqual([]);
    expect(perf.stats()).toEqual([]);
  });

  it('★ 出口自己抛错也不能连累被观测的主流程（observe 不抛）', () => {
    const perf = createPerfWatch({
      thresholdMs: 1,
      onReport: () => { throw new Error('日志盘满了'); },
    });
    expect(() => perf.observe('写库', 50)).not.toThrow();
  });

  it('summary 空表回空串，非空按最慢降序；reset 清空', () => {
    const perf = createPerfWatch({ thresholdMs: 100 });
    expect(perf.summary()).toBe('');
    perf.observe('快', 90);
    perf.observe('慢', 500);
    const s = perf.summary();
    expect(s.indexOf('慢')).toBeLessThan(s.indexOf('快'));
    perf.reset();
    expect(perf.summary()).toBe('');
  });
});

describe('timed', () => {
  it('返回值原样透传，耗时按注入时间源计', () => {
    let t = 0;
    const perf = createPerfWatch({ thresholdMs: 1000, now: () => t });
    const r = timed(() => t, '插入', perf, () => { t = 300; return 'ok' as const; });
    expect(r).toBe('ok');
    expect(perf.stats()[0]).toMatchObject({ label: '插入', total: 1, maxMs: 300 });
  });

  it('★ 被计时的函数抛错时：既记下耗时，也不吞异常（慢恰恰常伴随失败）', () => {
    let t = 0;
    const perf = createPerfWatch({ thresholdMs: 100, now: () => t });
    expect(() =>
      timed(() => t, '插入', perf, () => {
        t = 250;
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(perf.stats()[0]).toMatchObject({ total: 1, slow: 1, maxMs: 250 });
  });
});
