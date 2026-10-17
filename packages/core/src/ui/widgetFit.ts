/**
 * 小组件窗口高度自适应（用户反馈「小组件有一大部分是空白」）。
 *
 * ★ 背景：小组件是 280×420 的固定窗口，但列表只有 3–5 行时，flex-1 会把列表容器
 *   撑满剩余高度 → 下方一大片空白。真正的修法不是把行拉高，而是**让窗口跟着内容变高**
 *   （Windows 的 Win+V 面板就是这个行为）。
 *
 * ★ 为什么用「按条数算」而不是量 DOM：
 *   仓库没有 jsdom，量 DOM 的代码没法单测；而每行高度是固定的（单行预览 + 固定内边距），
 *   按条数算是确定性的，能钉死在单测里。
 */

/**
 * 除列表行之外的固定高度合计。
 * ★ 数值来自真机 DOM 实测（CDP 量 getBoundingClientRect）：
 *   标题栏 38 + 搜索区 46 + 列表上内边距 8 + 列表下内边距 8 + 底部状态栏 30 = 130，
 *   再减掉「最后一行没有行间距」的 4px → 126。
 */
export const WIDGET_CHROME_HEIGHT = 126;
/** 每行占的竖直空间：实测行高 34 + 行间距 4 = 38。 */
export const WIDGET_ROW_PITCH = 38;
/** 单行行高（WidgetRow：py-[5px]*2 + 11px 文字 * 1.5 + 上下边框），实测 34。 */
export const WIDGET_ROW_HEIGHT = 34;
/** 自动高度的下限：再矮连搜索框 + 一行都放不下。 */
export const WIDGET_AUTO_MIN_HEIGHT = 240;
/** 自动高度的上限：超过这个高度就滚动，不再继续长高。 */
export const WIDGET_AUTO_MAX_HEIGHT = 560;

/** 空列表也按一行算，避免窗口塌成一条缝。 */
export function widgetWindowHeight(
  itemCount: number,
  opts: { min?: number; max?: number } = {},
): number {
  const min = opts.min ?? WIDGET_AUTO_MIN_HEIGHT;
  const max = opts.max ?? WIDGET_AUTO_MAX_HEIGHT;
  const rows = Number.isFinite(itemCount) ? Math.max(1, Math.floor(itemCount)) : 1;
  const wanted = WIDGET_CHROME_HEIGHT + rows * WIDGET_ROW_PITCH;
  return Math.min(max, Math.max(min, wanted));
}
