/**
 * 开机自启动开关的状态推进（纯函数，便于单测）。
 *
 * 为什么需要它：平台值（app.getAutoStart）由 usePlatformValue 在挂载时**只读一次**，
 * 且没有任何刷新通道。如果组件直接拿 prop 做取反（onChange(!autoStart)），
 * 第一次点击写入 true 之后 prop 仍是 false，之后每次点击都会继续算出 true
 * —— 开关只能打开、永远关不掉（真机实测发现的 bug）。
 *
 * 所以开关必须自己维护现值，并在平台明确返回失败时回滚。
 */

export interface AutoStartToggleState {
  readonly on: boolean;
}

/** 挂载/平台值刷新时的初值；null（尚未读到）按关闭处理。 */
export function initialAutoStartToggle(platformValue: boolean | null): AutoStartToggleState {
  return { on: platformValue === true };
}

/** 用户点击：立刻乐观切换，并把**请求值**交给平台（不是取反 prop）。 */
export function autoStartClick(state: AutoStartToggleState): {
  state: AutoStartToggleState;
  requested: boolean;
} {
  const requested = !state.on;
  return { state: { on: requested }, requested };
}

/**
 * 平台写入结果。
 * ok === false 明确失败 → 回滚到点击前；
 * ok === undefined 表示平台没回报（老实现）→ 不回滚，避免误判。
 */
export function autoStartSettle(
  state: AutoStartToggleState,
  requested: boolean,
  ok: boolean | undefined,
): AutoStartToggleState {
  if (ok === false) return { on: !requested };
  return state;
}
