/**
 * 流式增量节流的用例。
 *
 * ★ 盯三件事：① 只发"新增尾巴"（界面按序追加）；② 节流真的生效但内容不丢；
 *   ③ 收尾一定把最后一段发出去（否则用户看到半截）。
 */
import { describe, expect, it } from 'vitest';
import { DELTA_INTERVAL_MS, createDeltaThrottle } from './deltaThrottle';

/** 假时钟 + 手动定时器：不真的等 120ms。 */
function makeClock() {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: t + ms, fn, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((x) => x.id === (id as unknown as number));
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      t += ms;
      for (const item of timers.filter((x) => x.at <= t)) {
        const i = timers.indexOf(item);
        if (i >= 0) timers.splice(i, 1);
        item.fn();
      }
    },
    pendingTimers: () => timers.length,
  };
}

function makeThrottle() {
  const clock = makeClock();
  const sent: { requestId: string; text: string }[] = [];
  const throttle = createDeltaThrottle({
    send: (requestId, text) => sent.push({ requestId, text }),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, sent, throttle };
}

describe('createDeltaThrottle', () => {
  it('首次 push 立刻发出全文（没有等待，首字快）', () => {
    const { sent, throttle } = makeThrottle();
    throttle.push('r1', '你好');
    expect(sent).toEqual([{ requestId: 'r1', text: '你好' }]);
  });

  it('只发新增尾巴：同一请求连续推送时界面追加即可拼回全文', () => {
    const { clock, sent, throttle } = makeThrottle();
    throttle.push('r1', '你好');
    clock.advance(DELTA_INTERVAL_MS);
    throttle.push('r1', '你好，世界');
    const joined = sent.map((s) => s.text).join('');
    expect(joined).toBe('你好，世界');
    expect(sent.length).toBe(2);
  });

  it('间隔内的多次 push 只发一次，且发的是最新一版（中间帧丢弃不丢内容）', () => {
    const { clock, sent, throttle } = makeThrottle();
    throttle.push('r1', 'a');
    throttle.push('r1', 'ab');
    throttle.push('r1', 'abc');
    expect(sent).toEqual([{ requestId: 'r1', text: 'a' }]);
    clock.advance(DELTA_INTERVAL_MS);
    expect(sent.map((s) => s.text).join('')).toBe('abc');
    expect(sent.length).toBe(2);
  });

  it('end 会把最后一段立刻发出去并清表（否则最后一帧被节流吞掉）', () => {
    const { sent, throttle } = makeThrottle();
    throttle.push('r1', 'a');
    throttle.push('r1', 'ab');
    throttle.end('r1');
    expect(sent.map((s) => s.text).join('')).toBe('ab');
    expect(throttle.pending()).toBe(0);
  });

  it('end 之后同一 requestId 再来增量会被当成新请求（状态已清空）', () => {
    const { sent, throttle } = makeThrottle();
    throttle.push('r1', 'a');
    throttle.end('r1');
    throttle.push('r1', 'b');
    expect(sent[sent.length - 1]).toEqual({ requestId: 'r1', text: 'b' });
  });

  it('预览文本非单调（不再以上次已发内容开头）时跳过这一帧，不发脏尾巴', () => {
    const { clock, sent, throttle } = makeThrottle();
    throttle.push('r1', '你好');
    clock.advance(DELTA_INTERVAL_MS);
    // 预览被重算成完全不同的开头：追加语义下无法回退，跳过。
    throttle.push('r1', '完全不同');
    clock.advance(DELTA_INTERVAL_MS);
    expect(sent).toEqual([{ requestId: 'r1', text: '你好' }]);
  });

  it('文本没变时不发空尾巴', () => {
    const { clock, sent, throttle } = makeThrottle();
    throttle.push('r1', '你好');
    clock.advance(DELTA_INTERVAL_MS);
    throttle.push('r1', '你好');
    clock.advance(DELTA_INTERVAL_MS);
    expect(sent.length).toBe(1);
  });

  it('两个请求互不干扰，各自只发自己的尾巴', () => {
    const { clock, sent, throttle } = makeThrottle();
    throttle.push('r1', 'a');
    throttle.push('r2', 'x');
    clock.advance(DELTA_INTERVAL_MS);
    throttle.push('r1', 'ab');
    throttle.push('r2', 'xy');
    expect(sent).toEqual([
      { requestId: 'r1', text: 'a' },
      { requestId: 'r2', text: 'x' },
      { requestId: 'r1', text: 'b' },
      { requestId: 'r2', text: 'y' },
    ]);
  });

  it('空 requestId / 非字符串内容一律忽略，不抛错也不建状态', () => {
    const { sent, throttle } = makeThrottle();
    throttle.push('', '脏数据');
    throttle.push('r1', 123 as unknown as string);
    expect(sent).toEqual([]);
    expect(throttle.pending()).toBe(0);
  });
});
