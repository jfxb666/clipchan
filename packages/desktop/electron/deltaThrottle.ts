/**
 * 流式增量的节流与"尾巴"投影（main.ts 用它把 onPreview 变成 IPC 事件）。
 *
 * ★ 契约（与 core 的 mergeDelta 一致）：发出去的 text 是**新增尾巴**，界面按序追加。
 *   所以内部存"上次已发到哪"（sent），只发 text.slice(sent.length)。
 * ★ 节流是覆盖语义：同一窗口内多次 push 只留最新一版全文，中间帧丢弃不丢内容。
 * ★ 非单调（预览被重算、不再以上次已发内容开头）时这一帧跳过：追加语义下无法回退，
 *   宁可不更新预览；最终结果由 invoke 的返回值覆盖，不会错。
 * ★ 本模块不 import electron，所以能在 node 下直接测。
 */

/** 两条增量之间的最小间隔：点点这类模型每秒可能吐几十块，逐块 IPC 会把渲染进程打满。 */
export const DELTA_INTERVAL_MS = 120;

interface DeltaState {
  /** 最新一版完整预览。 */
  text: string;
  /** 已发给渲染层的前缀（下次只发它的尾巴）。 */
  sent: string;
  /** 上次真正发出的时刻（0 = 还没发过）。 */
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface DeltaThrottleDeps {
  /** 真正的发送动作；text 是新增尾巴，不是全文。 */
  send: (requestId: string, tail: string) => void;
  /** 时钟与定时器可注入（测试用假时钟，避免真的等 120ms）。 */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface DeltaThrottle {
  /** 收到一段预览（全文覆盖）；同一 requestId 的连续调用只保留最新一版。 */
  push(requestId: string, text: string): void;
  /** 请求收尾：把最后一段尾巴立刻发出去并清表（成功失败都要调）。 */
  end(requestId: string): void;
  /** 还有多少请求在途（测试与诊断用）。 */
  pending(): number;
}

export function createDeltaThrottle(deps: DeltaThrottleDeps): DeltaThrottle {
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const state = new Map<string, DeltaState>();

  const flush = (requestId: string): void => {
    const st = state.get(requestId);
    if (!st) return;
    st.last = now();
    st.timer = null;
    // 非单调：追加语义下回不去，这一帧跳过（最终结果由 invoke 返回值覆盖）。
    if (!st.text.startsWith(st.sent)) return;
    const tail = st.text.slice(st.sent.length);
    if (tail === '') return;
    st.sent = st.text;
    deps.send(requestId, tail);
  };

  return {
    push(requestId, text) {
      if (typeof requestId !== 'string' || requestId === '' || typeof text !== 'string') return;
      let st = state.get(requestId);
      if (!st) {
        // 首块立刻发：把 last 拨回到"刚好等够一个间隔"，不让首字白等 120ms。
        st = { text, sent: '', last: now() - DELTA_INTERVAL_MS, timer: null };
        state.set(requestId, st);
      }
      st.text = text;
      const wait = DELTA_INTERVAL_MS - (now() - st.last);
      if (wait <= 0) {
        if (st.timer) {
          clearT(st.timer);
          st.timer = null;
        }
        flush(requestId);
        return;
      }
      if (!st.timer) st.timer = setT(() => flush(requestId), wait);
    },

    end(requestId) {
      const st = state.get(requestId);
      if (!st) return;
      if (st.timer) clearT(st.timer);
      flush(requestId);
      state.delete(requestId);
    },

    pending: () => state.size,
  };
}
