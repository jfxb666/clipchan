/**
 * 真毛玻璃（spec §6.6 / §7.2，用户拍板 2b）+ 窗口定位纯几何。
 *
 * ★ 为什么由原生助手做：本机是 Win10 19045，`backgroundMaterial:'acrylic'` 不可用
 *   （那是 Win11 22H2+ 的能力）；CSS `backdrop-filter` 在 Electron 里**只模糊窗口内的
 *   内容、不模糊窗口背后的桌面**。所以真磨砂只能由助手调 DWM：
 *   `SetWindowCompositionAttribute` + `ACCENT_ENABLE_ACRYLICBLURBEHIND`（优先）
 *   / `ACCENT_ENABLE_BLURBEHIND`（回落）——回落逻辑在助手进程内
 *   （`packages/desktop/helper/ClipchanHelper.cs` 的 `ApplyBlur`），**两层都失败才算降级**。
 *
 * 本文件分两部分：
 *   ① 纯几何（positionFor / displayForPoint / isOnAnyDisplay）：零运行时依赖，
 *      可被 vitest 直接单测（frosted.spec.ts 只测这一部分）；
 *   ② FrostedGlass：需要 BrowserWindow（type-only import，运行期被擦除）与助手窄接口。
 * ★ 顺序很重要：windows.ts 从这里 import 几何，所以这里**绝不能** import windows.ts，
 *   否则形成循环依赖。
 */

// ─────────────────────────── ① 纯几何 ───────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Electron `Display` 里我们用到的两个字段（用窄结构以便单测造数据）。 */
export interface DisplayLike {
  bounds: Rect;
  workArea: Rect;
}

export const MAIN_WIDTH = 900;
export const MAIN_HEIGHT = 620;
/** 主窗口居中后再上移这么多，视觉重心更靠上（spec §6.6「中间偏上」）。 */
export const MAIN_TOP_OFFSET = 40;
export const WIDGET_WIDTH_DEFAULT = 280;
export const WIDGET_HEIGHT_DEFAULT = 420;
export const WIDGET_MARGIN = 24;
/** 判定「记忆位置还算数」时，至少要有多大一块落在某块显示器内（够抓到标题栏）。 */
export const MIN_VISIBLE_PX = 80;

/** 窗口圆角半径（与 --cc-radius-card 一致）。 */
export const WINDOW_RADIUS = 16;

/**
 * 把「圆角矩形」近似成一串水平条带 —— Electron 的 `win.setShape(rects)` 只吃
 * 矩形数组（SetWindowRgn 的矩形联合）。圆角外侧的像素与鼠标事件都会被系统裁掉，
 * 这样透明窗口在 Win10 上也能有干净的圆角（实测见下）。
 *
 * ★ 为什么要这么做（2026-10-17 六组探针实测）：
 *   Win10 19045 上 SetWindowCompositionAttribute 的 acrylic / blur **会铺满整个 HWND
 *   矩形**，且 Electron 的 setShape(SetWindowRgn) 裁不掉它 —— 圆角外侧露出一圈浅灰白，
 *   就是用户报的「四边白色突出」。反过来，**不做系统模糊时 setShape 的圆角完全干净**
 *   （圆角外直接透出桌面）。两者不可兼得，所以选择干净圆角 + 88% 半透明。
 */
export function roundedRectRects(width: number, height: number, radius: number): Rect[] {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(Math.min(w, h) / 2)));
  if (r <= 0) return [{ x: 0, y: 0, width: w, height: h }];

  const rects: Rect[] = [];
  // 上半圆：每行一条，左右各内缩 inset
  for (let y = 0; y < r; y++) {
    const dy = r - y - 0.5;
    const inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    rects.push({ x: inset, y, width: Math.max(1, w - inset * 2), height: 1 });
  }
  // 中段：一整块
  const middle = h - r * 2;
  if (middle > 0) rects.push({ x: 0, y: r, width: w, height: middle });
  // 下半圆
  for (let y = 0; y < r; y++) {
    const dy = y + 0.5;
    const inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    rects.push({ x: inset, y: h - r + y, width: Math.max(1, w - inset * 2), height: 1 });
  }
  return rects;
}

/**
 * 挑一块显示器：鼠标点在哪块就用哪块（spec §6.6 实测该 API 可用）。
 * 纯函数版 —— Electron 的 `screen.getDisplayNearestPoint` 只能在主进程调，
 * 这里是为了能在 vitest 里测多显示器分支。
 */
export function displayForPoint(displays: DisplayLike[], cursor: Point): DisplayLike | null {
  if (displays.length === 0) return null;
  const hit = displays.find((d) => containsPoint(d.bounds, cursor));
  if (hit) return hit;
  // 不在任何显示器内（多屏间隙 / 坐标越界）：退化为「中心最近」的那块。
  let best = displays[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const d of displays) {
    const cx = d.bounds.x + d.bounds.width / 2;
    const cy = d.bounds.y + d.bounds.height / 2;
    const dist = (cx - cursor.x) ** 2 + (cy - cursor.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

function containsPoint(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x < rect.x + rect.width && p.y >= rect.y && p.y < rect.y + rect.height;
}

/** 记忆的位置是否还落在某块显示器里（否则回落到默认位置，不能把窗口丢到不存在的坐标）。 */
export function isOnAnyDisplay(rect: Rect, displays: DisplayLike[]): boolean {
  if (displays.length === 0) return false;
  return displays.some((d) => {
    const wa = d.workArea;
    const overlapX = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
    const overlapY = Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y);
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
  });
}

/** 小组件宽度夹到 240–400（spec §6.6）。 */
export function clampWidgetWidth(px: number | undefined): number {
  if (px === undefined || !Number.isFinite(px)) return WIDGET_WIDTH_DEFAULT;
  return Math.min(400, Math.max(240, Math.round(px)));
}

export interface PositionRequest {
  mode: 'main' | 'widget';
  /** 目标显示器（一般由 displayForPoint(displays, 鼠标位置) 得到）。 */
  display: DisplayLike;
  /** 全部显示器：用于判定 remembered 是否还有效。 */
  displays?: DisplayLike[];
  /** 上次记住的窗口位置（主窗口形态用）。 */
  remembered?: Rect | null;
  /** 小组件宽度（设置里的 widgetSize）。 */
  widgetWidth?: number;
  /** 小组件实际高度（内容自适应后会变；缺省用 420）。 */
  widgetHeight?: number;
}

/**
 * 算出窗口该待的矩形（纯函数，spec §6.6）：
 * - 主窗口：有可用记忆位置就用它，否则在目标显示器**居中偏上**；
 * - 小组件：目标显示器**右下角、距边 24px**。
 */
export function positionFor(req: PositionRequest): Rect {
  const wa = req.display.workArea;
  if (req.mode === 'widget') {
    const width = clampWidgetWidth(req.widgetWidth);
    // ★ 高度不再是固定 420：小组件会按内容自适应（WidgetView 量完内容后 resizeBy），
    //   贴边位置必须按**实际高度**算，否则缩矮后底部会浮起来。
    const height =
      req.widgetHeight !== undefined && Number.isFinite(req.widgetHeight) && req.widgetHeight > 0
        ? Math.round(req.widgetHeight)
        : WIDGET_HEIGHT_DEFAULT;
    return {
      x: Math.round(wa.x + wa.width - width - WIDGET_MARGIN),
      y: Math.round(wa.y + wa.height - height - WIDGET_MARGIN),
      width,
      height,
    };
  }

  const remembered = req.remembered;
  if (remembered && isOnAnyDisplay(remembered, req.displays ?? [req.display])) {
    return {
      x: Math.round(remembered.x),
      y: Math.round(remembered.y),
      width: MAIN_WIDTH,
      height: MAIN_HEIGHT,
    };
  }

  return {
    x: Math.round(wa.x + (wa.width - MAIN_WIDTH) / 2),
    y: Math.round(wa.y + Math.max(0, (wa.height - MAIN_HEIGHT) / 2 - MAIN_TOP_OFFSET)),
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
  };
}

// ─────────────────────────── ② FrostedGlass ───────────────────────────

/** 助手窄接口（`HelperClient` 结构上就满足，勿再包一层）。 */
export interface BlurCapable {
  readonly available: boolean;
  blur(hwnd: number, on: boolean, abgr?: number): Promise<boolean>;
}

/** 面板底色 88% 奶油白（spec §6.1 的 --cc-glass 对应色，ABGR 十进制）。 */
export const PANEL_ABGR = 0xccfff8f0;

/** 从 BrowserWindow 取原生窗口句柄（x64 上是 8 字节小端）。取不到返回 0。 */
export function handleOf(win: {
  getNativeWindowHandle(): Buffer;
  isDestroyed(): boolean;
}): number {
  try {
    if (win.isDestroyed()) return 0;
    const buf = win.getNativeWindowHandle();
    if (!buf || buf.length < 4) return 0;
    if (buf.length >= 8) return Number(buf.readBigInt64LE(0));
    return buf.readInt32LE(0);
  } catch {
    return 0;
  }
}

/**
 * 毛玻璃开关。
 *
 * 诚实语义（Global Constraints「不假装」）：
 * - `active`：**当前**这次 apply 是否成功（隐藏窗口时会被关掉 → false）；
 * - `supported`：**这台机器上到底能不能做真毛玻璃**（一旦成功过就保持 true，
 *   用于 `capabilities.frostedGlass`，不会因为窗口隐藏而翻回 false）。
 */
export class FrostedGlass {
  private readonly helper: BlurCapable;
  private readonly abgr: number;

  private activeFlag = false;
  private supportedFlag = false;

  constructor(deps: { helper: BlurCapable; abgr?: number }) {
    this.helper = deps.helper;
    this.abgr = (deps.abgr ?? PANEL_ABGR) >>> 0;
  }

  /** 当前是否处于开启状态且真的生效。 */
  get active(): boolean {
    return this.activeFlag;
  }

  /** 本机是否支持真毛玻璃（capabilities.frostedGlass 的来源）。 */
  get supported(): boolean {
    return this.supportedFlag;
  }

  /**
   * 开/关毛玻璃。返回是否成功（成功即 `active===true`）。
   * 助手不可用、句柄取不到、助手返回码非 0 —— 一律 false，由界面如实显示「已降级」。
   */
  async apply(win: Parameters<typeof handleOf>[0], enabled: boolean): Promise<boolean> {
    if (!this.helper.available) {
      this.activeFlag = false;
      return false;
    }
    const hwnd = handleOf(win);
    if (hwnd <= 0) {
      this.activeFlag = false;
      return false;
    }

    if (!enabled) {
      try {
        await this.helper.blur(hwnd, false, 0);
      } catch {
        // 关不上也不影响功能，只是白费一点 GPU。
      }
      this.activeFlag = false;
      return false;
    }

    let ok = false;
    try {
      // ★ 必须显式传色值：助手只认十进制（十六进制会判成参数错误码 5）。
      ok = await this.helper.blur(hwnd, true, this.abgr);
    } catch {
      ok = false;
    }
    this.activeFlag = ok;
    if (ok) this.supportedFlag = true;
    return ok;
  }
}
