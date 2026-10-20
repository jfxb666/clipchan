/**
 * 截图主进程的纯逻辑（计划 §3 T2）。
 *
 * ★ 为什么不 import electron：`desktopCapturer` / `screen` 在 vitest 里拿不到，
 *   而「多显示器怎么配 source」「CSS 像素怎么换物理像素」正是最容易算错、又最值得
 *   用真实数字钉死的部分（双屏 + 125%/150% 缩放是常见配置）。所以这里只吃窄结构，
 *   真窗口的创建在 overlay.ts。
 * ★ Rect 复用 frosted.ts 的那一份：几何类型全项目只有一处定义，避免两份结构相同的
 *   类型在调用点互不兼容。type-only import 在运行期被完全擦除，不会把 electron 拖进来。
 */
import type { CaptureAction } from '@clipchan/core';
import type { Rect } from './frosted';

/** Electron `screen.Display` 里本模块用到的字段（窄结构，便于单测造数据）。 */
export interface DisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

/**
 * Electron `desktopCapturer` 返回的 source 里本模块用到的字段。
 * 只需要 display_id 与缩略图尺寸，所以不 import electron 的 DesktopCapturerSource。
 */
export interface SourceLike {
  id: string;
  display_id: string;
  thumbnail: { getSize(): { width: number; height: number } };
}

/**
 * 抓屏请求的缩略图尺寸。
 *
 * ★ 实测（2026-10-20）：`desktopCapturer` 的 `thumbnailSize` 吃的是**物理像素** ——
 *   给它 3840×2160 就真回 3840×2160，不按 scaleFactor 再乘一次。所以这里必须
 *   把 DIP 尺寸乘上 scaleFactor，否则 125%/150% 缩放的机器抓到的是模糊图。
 */
export function thumbnailSizeFor(display: DisplayLike): { width: number; height: number } {
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
}

/**
 * 给某块显示器挑出它对应的抓屏 source。
 *
 * ★ 对不上就返回 null，**绝不猜**：多显示器时随便挑一个 source 会把别人的屏幕
 *   画到这块屏的 overlay 上（用户看到的是另一块屏的内容，比抓不到更糟）。
 *   唯一例外是「单屏 + 单个 source」——那时不存在歧义，某些 Windows 版本给的
 *   display_id 与 `Display.id` 对不上，不兜底就永远抓不到。
 */
export function matchSource(
  sources: SourceLike[],
  display: DisplayLike,
  displayCount: number,
): SourceLike | null {
  const exact = sources.find((s) => s.display_id === String(display.id));
  if (exact) return exact;
  if (sources.length === 1 && displayCount === 1) return sources[0] ?? null;
  return null;
}

/**
 * 把选区夹进显示器矩形。
 *
 * ★ 宽高必须归零而不是返回负数：负尺寸传进 canvas 的 drawImage / toDataURL 会
 *   静默产出空白图，用户点「完成」后拿到的是一张透明 PNG，比明确失败更难查。
 */
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return { x: left, y: top, width: 0, height: 0 };
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 把 CSS 像素的选区换成底图里的物理像素矩形。
 *
 * 底图是 `thumbnailSizeFor` 那个物理像素尺寸，overlay 里的选区却是 CSS 像素，
 * 两者差一个 scaleFactor；不换算就会在 150% 的机器上裁到左上角一小块。
 */
export function cropRectInImage(sel: Rect, display: DisplayLike): Rect {
  const size = thumbnailSizeFor(display);
  const scaled: Rect = {
    x: Math.round(sel.x * display.scaleFactor),
    y: Math.round(sel.y * display.scaleFactor),
    width: Math.round(sel.width * display.scaleFactor),
    height: Math.round(sel.height * display.scaleFactor),
  };
  return clampRect(scaled, { x: 0, y: 0, width: size.width, height: size.height });
}

/** 截图完成后的中文提示（给 toast 用）。 */
export function describeFinish(action: CaptureAction): string {
  switch (action) {
    case 'copy':
      return '已复制到剪贴板';
    case 'paste':
      return '已粘贴到目标窗口';
    case 'save':
      return '已保存为文件';
    default:
      // 兜底：IPC 传进来的值不受类型约束，宁可显示一句通用话也不让 toast 出现 undefined。
      return '截图已处理';
  }
}
