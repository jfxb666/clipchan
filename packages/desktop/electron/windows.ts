/**
 * 窗口创建与形态切换。
 *
 * ★ 实测（spec §15 第 18 条）：BrowserWindow 的 frame / transparent / hasShadow 只能
 *   在创建时定，运行时改不了 —— 所以主窗口与小组件用**同一套创建参数**建窗，
 *   形态差异只体现在尺寸、可缩放性、置顶与内容布局上（spec §6.6）。
 * ★ Win10 19045 没有系统级圆角与 acrylic，圆角靠 CSS border-radius + 透明窗口，
 *   真毛玻璃由助手调 DWM（Task 8）。
 */
import { BrowserWindow, app, screen } from 'electron';
import * as path from 'node:path';
import {
  WINDOW_RADIUS,
  displayForPoint,
  positionFor,
  roundedRectRects,
  type DisplayLike,
  type Rect,
} from './frosted';
import { EV } from './channels';

export type WinMode = 'main' | 'widget';

export const MAIN_SIZE = { width: 900, height: 620 } as const;
export const MAIN_MIN = { width: 720, height: 480 } as const;
export const MAIN_MAX = { width: 1200, height: 900 } as const;
export const WIDGET_SIZE = { width: 280, height: 420 } as const;
// ★ 高度下限 240：小组件会按内容自适应变矮（用户报「一大片空白」），300 太高会留白。
export const WIDGET_MIN = { width: 240, height: 240 } as const;
export const WIDGET_MAX = { width: 400, height: 900 } as const;

/** 小组件贴边距离（spec §6.4/§6.6：距边 24px）。真源在 frosted.ts，这里转出。 */
export { WIDGET_MARGIN } from './frosted';

export interface CreateWindowOpts {
  mode: WinMode;
  show: boolean;
  preload: string;
  /** 开发期：加载 Vite dev server。 */
  devServerUrl?: string;
  /** 生产：加载打包好的 index.html。 */
  file?: string;
  /** 小组件初始宽度（设置里的 widgetSize）。 */
  widgetSize?: number;
  /**
   * 延迟显示与加载（Task 8 真毛玻璃需要）：
   * 渲染进程在 preload 阶段用 sendSync 取一次 capabilities，所以**真毛玻璃必须在
   * 页面加载之前就应用好**，否则界面第一次读到的永远是 false，一直显示"已降级"。
   * 传 true 时本函数只建窗，显示与加载交给 loadRenderer()。
   */
  defer?: boolean;
}

/** 给窗口挑一块显示器：优先鼠标所在那块（spec §6.6）。 */
export function cursorDisplay() {
  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor);
}

/** 全部显示器（按 workArea 判记忆位置是否还有效）。 */
export function allDisplays(): DisplayLike[] {
  return screen.getAllDisplays();
}

/**
 * 把窗口摆到目标位置。
 *
 * 几何计算全在 frosted.ts 的纯函数 `positionFor` 里（可单测），这里只负责
 * 「取鼠标所在显示器 + 应用 bounds」这两个必须有 Electron 才能做的事。
 * - 主窗口：有可用记忆位置就用记忆位置（spec §6.6「记忆上次位置，越界则回落」）；
 * - 小组件：贴鼠标所在显示器右下角、距边 24px。
 */
export function placeWindow(
  win: BrowserWindow,
  mode: WinMode,
  widgetSize?: number,
  remembered?: Rect | null,
  widgetHeight?: number,
): void {
  const displays = allDisplays();
  const cursor = screen.getCursorScreenPoint();
  const display = displayForPoint(displays, cursor) ?? cursorDisplay();
  const rect = positionFor({
    mode,
    display,
    displays,
    remembered: mode === 'main' ? (remembered ?? null) : null,
    widgetWidth: widgetSize,
    widgetHeight,
  });
  win.setBounds(rect);
  applyWindowShape(win);
}

/**
 * 把窗口裁成圆角矩形（Win10 没有系统圆角，transparent 窗口的圆角外区域会露出
 * 桌面/系统模糊层 —— 用户报的「四边白色突出」）。
 *
 * ★ 实测（2026-10-17，六组探针）：
 *   - 不做系统模糊时，setShape 的圆角**完全干净**，圆角外直接透出桌面；
 *   - 一旦调用 SetWindowCompositionAttribute 的 acrylic/blur，系统层会铺满整个
 *     HWND 矩形，setShape 裁不掉 → 圆角外一圈浅灰白。
 *   两者不可兼得，所以本项目**不做系统模糊**，改用「真圆角 + 88% 半透明」。
 *
 * setShape 是实验性 API（win32/linux），失败只记日志不抛 —— 圆角退化不该让窗口打不开。
 */
export function applyWindowShape(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    // noUncheckedIndexedAccess：getSize() 的元素类型是 number | undefined，兜一下。
    const [w = 0, h = 0] = win.getSize();
    if (w <= 0 || h <= 0) return;
    win.setShape(roundedRectRects(w, h, WINDOW_RADIUS));
  } catch (err) {
    console.warn('[shape] 设置圆角失败（退化为直角）：' + String(err));
  }
}

/**
 * 小组件按内容设置高度（用户反馈「小组件有一大部分是空白」）。
 *
 * 宽度不变（仍取当前宽度），高度夹到 WIDGET_MIN.height–WIDGET_MAX.height，
 * 然后**重新贴右下角**（高度变了，底边距才不会飘）+ 重设圆角。
 */
export function setWidgetHeight(win: BrowserWindow, height: number): void {
  if (win.isDestroyed()) return;
  const [w = WIDGET_SIZE.width] = win.getSize();
  const width = clampWidgetSize(w);
  const nextH = clampWidgetHeight(height);
  lastWidgetHeight = nextH;
  win.setSize(width, nextH);
  placeWindow(win, 'widget', width, null, nextH);
}

/** 小组件宽度夹到 240–400（spec §6.6）。 */
export function clampWidgetSize(px: number): number {
  if (!Number.isFinite(px)) return WIDGET_SIZE.width;
  return Math.min(WIDGET_MAX.width, Math.max(WIDGET_MIN.width, Math.round(px)));
}

/** 小组件高度夹到 240–900（按内容自适应，见 setWidgetHeight）。 */
export function clampWidgetHeight(px: number): number {
  if (!Number.isFinite(px)) return WIDGET_SIZE.height;
  return Math.min(WIDGET_MAX.height, Math.max(WIDGET_MIN.height, Math.round(px)));
}

/** 上一次主窗口的位置（spec §6.6：记忆上次位置，越界自动回落）。 */
let lastMainRect: Rect | null = null;

/**
 * 小组件上一次按内容算出来的高度。
 *
 * ★ 为什么必须在主进程记住（真机实测的回归）：applyMode 每次切形态都会
 *   `setSize(width, WIDGET_SIZE.height)`，而渲染进程的自适应高度 effect 只在
 *   `mode` 或 `items.length` 变化时才跑 —— 于是「拖宽度 → applyMode → 高度被重置成 420」
 *   之后没人再把它改回来，小组件又变回一大片空白。把高度存在这里，
 *   applyMode 一律用它，任何路径（拖宽/托盘/热键）都不会再把高度打回默认值。
 */
let lastWidgetHeight: number = WIDGET_SIZE.height;

/** 供测试/收尾读取当前记住的小组件高度。 */
export function rememberedWidgetHeight(): number {
  return lastWidgetHeight;
}

/** 供测试/收尾读取当前记住的主窗口位置。 */
export function rememberedMainRect(): Rect | null {
  return lastMainRect;
}

export function createMainWindow(opts: CreateWindowOpts): BrowserWindow {
  const isWidget = opts.mode === 'widget';
  const win = new BrowserWindow({
    width: isWidget ? clampWidgetSize(opts.widgetSize ?? WIDGET_SIZE.width) : MAIN_SIZE.width,
    height: isWidget ? WIDGET_SIZE.height : MAIN_SIZE.height,
    minWidth: isWidget ? WIDGET_MIN.width : MAIN_MIN.width,
    minHeight: isWidget ? WIDGET_MIN.height : MAIN_MIN.height,
    maxWidth: isWidget ? WIDGET_MAX.width : MAIN_MAX.width,
    maxHeight: isWidget ? WIDGET_MAX.height : MAIN_MAX.height,
    // ★ 实测：这三项只能在创建时定死，两种形态共用同一套。
    frame: false,
    transparent: true,
    hasShadow: false,
    // ★ 关掉系统缩放边框（WS_THICKFRAME）。真机实测：留着它时鼠标落在窗口右缘/右下角
    //   会被 Windows 原生 resize 边框接管，渲染层的自绘手柄**一个 pointer 事件都收不到**
    //   → 向外拖能变大（系统边框干的），向内拖完全没反应。关掉后指针事件回到页面，
    //   两个方向都走我们自己的 resizeBy（用户反馈的「拖拽手感很一般」）。
    thickFrame: false,
    backgroundColor: '#00000000',
    show: false,
    resizable: !isWidget,
    skipTaskbar: isWidget,
    alwaysOnTop: isWidget,
    title: '剪贴板酱',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      preload: opts.preload,
      devTools: !app.isPackaged,
    },
  });

  // 建窗后立刻定位（主窗口居中偏上 / 小组件贴右下角），避免出现"先闪在左上角"。
  placeWindow(win, opts.mode, opts.widgetSize);
  // 圆角：必须在窗口有尺寸之后设置（形状是绝对矩形，尺寸变了要重设）。
  applyWindowShape(win);

  // ★★ 真机实测（2026-10-17）：窗口尺寸变化后，之前 setShape 设下的区域仍是**旧尺寸**。
  //   窗口变大时，新增出来的边缘落在区域之外 —— 那块地方既不绘制、**也收不到鼠标**
  //   （事件穿透到下层窗口）。用户报的「拖拽手感很一般」实际就是：向外拖能变大，
  //   向内拖完全没反应，因为缩小后窗口边缘不在旧区域里，pointerdown 根本到不了渲染层。
  //   GetWindowRgn 实测：窗口 1044x480 时区域还是 0,0,970,667；右缘 X-2…X-40 命中
  //   测试全部返回别的窗口。
  //   所以任何一次尺寸变化后都必须按新尺寸重设形状。拖拽中节流 50ms 一次，
  //   既不打断手感，也不会让区域长期过期。
  let shapeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleShape = (): void => {
    if (win.isDestroyed()) return;
    if (shapeTimer) clearTimeout(shapeTimer);
    shapeTimer = setTimeout(() => {
      shapeTimer = null;
      applyWindowShape(win);
    }, 50);
  };
  win.on('resize', scheduleShape);
  // 显示/隐藏也会让 Windows 重新评估窗口区域，顺手补一次。
  win.on('show', () => applyWindowShape(win));
  win.on('closed', () => {
    if (shapeTimer) clearTimeout(shapeTimer);
    shapeTimer = null;
  });

  if (!opts.defer) {
    if (opts.show) win.show();
    loadRenderer(win, opts);
  }
  return win;
}

/** 显示并加载渲染页面（与 createMainWindow({defer:true}) 配对使用）。 */
export function loadRenderer(
  win: BrowserWindow,
  opts: { show?: boolean; devServerUrl?: string; file?: string },
): void {
  if (win.isDestroyed()) return;
  if (opts.show) win.show();
  if (opts.devServerUrl) {
    void win.loadURL(opts.devServerUrl);
  } else if (opts.file) {
    void win.loadFile(opts.file);
  }
}

/**
 * 换形态：改尺寸 + 可缩放性 + 置顶 + 位置，并通知渲染进程切视图。
 * ★ 不重建窗口 —— 两个窗口意味着两套 React 状态（spec §6.6）。
 */
export function applyMode(win: BrowserWindow, mode: WinMode, widgetSize?: number): void {
  if (win.isDestroyed()) return;
  // 切走之前先记住主窗口的位置（spec §6.6「记忆上次位置」）；
  // 小组件的位置不值得记（永远贴右下角）。
  if (mode === 'widget') {
    const [w, h] = win.getSize();
    if (w === MAIN_SIZE.width && h === MAIN_SIZE.height) {
      const b = win.getBounds();
      lastMainRect = { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  }
  if (mode === 'widget') {
    win.setResizable(false);
    win.setAlwaysOnTop(true);
    win.setSkipTaskbar(true);
    const width = clampWidgetSize(widgetSize ?? WIDGET_SIZE.width);
    // ★ 用记住的自适应高度，不能用固定 WIDGET_SIZE.height —— 否则任何一次
    //   applyMode（拖宽、托盘、热键）都会把「按内容变矮」的成果打回 420 留白。
    const height = clampWidgetHeight(lastWidgetHeight);
    win.setMinimumSize(WIDGET_MIN.width, WIDGET_MIN.height);
    win.setMaximumSize(WIDGET_MAX.width, WIDGET_MAX.height);
    win.setSize(width, height);
    placeWindow(win, 'widget', width, null, height);
  } else {
    win.setResizable(true);
    win.setAlwaysOnTop(false);
    win.setSkipTaskbar(false);
    win.setMinimumSize(MAIN_MIN.width, MAIN_MIN.height);
    win.setMaximumSize(MAIN_MAX.width, MAIN_MAX.height);
    win.setSize(MAIN_SIZE.width, MAIN_SIZE.height);
    placeWindow(win, 'main', undefined, lastMainRect);
    applyWindowShape(win);
  }
  win.webContents.send(EV.modeChanged, mode);
}

/**
 * 自绘缩放手柄用：按增量改尺寸并夹在 min/max 之间。
 *
 * ★ `shape` 参数是「拖拽手感」的关键（用户反馈「拖拽的手感很一般」）：
 *   setShape 每次要下发 30+ 个矩形（SetWindowRgn），逐帧调用会让 pointermove
 *   明显掉帧。拖拽过程中只改尺寸（圆角外本来就是透明像素，短暂直角看不出来），
 *   松手（shape=true）再补一次圆角。
 */
export function resizeBy(
  win: BrowserWindow,
  dw: number,
  dh: number,
  mode: WinMode,
  shape = true,
): void {
  if (win.isDestroyed()) return;
  const bounds = win.getBounds();
  const min = mode === 'widget' ? WIDGET_MIN : MAIN_MIN;
  const max = mode === 'widget' ? WIDGET_MAX : MAIN_MAX;
  const nextW = Math.min(max.width, Math.max(min.width, Math.round(bounds.width + dw)));
  const nextH = Math.min(max.height, Math.max(min.height, Math.round(bounds.height + dh)));
  // ★ 必须用 setBounds，不能用 setSize（2026-10-17 真机 + 最小探针证死）：
  //   frame:false + transparent:true + thickFrame:false 的窗口在 Windows 上是
  //   **非 resizable** 的（thickFrame 关掉就没有 WS_THICKFRAME），此时
  //   setSize() 只对「变大」生效，**变小被系统静默忽略**
  //   —— 用户报的「拖拽手感很一般」实际是「只能拉大、拉不小」。
  //   同一窗口用 setBounds 两个方向都精确生效（2026-10-17 真机实测）。
  win.setBounds({ x: bounds.x, y: bounds.y, width: nextW, height: nextH });
  if (mode === 'widget') lastWidgetHeight = nextH;
  if (shape) applyWindowShape(win);
}

/** 打包后资源在 process.resourcesPath，开发期在仓库根。 */
export function assetPath(...parts: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..');
  return path.join(base, ...parts);
}
