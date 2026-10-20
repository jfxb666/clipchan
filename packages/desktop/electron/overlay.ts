/**
 * 截图 overlay 窗口（计划 §1 铁律一 / §3 T2）。
 *
 * ★ 为什么单独建窗，而不是复用主窗口：overlay 要「每显示器一个全屏无边框置顶窗」，
 *   而主窗口那套参数（900x620、transparent、圆角 setShape）只能在创建时定死
 *   （见 windows.ts:171-240）。两者参数没有交集，所以这里是独立的一套。
 * ★ 为什么透明关掉：overlay 的底图是「先抓后铺」的截图（铁律二），窗口本身就画
 *   那张图，透明只会让桌面透出来干扰取景。
 * ★ 为什么不调 applyWindowShape：setShape 会把窗口裁成圆角，而 overlay 是全屏矩形，
 *   圆角之外那块区域直接露出桌面 —— 用户看到的就是「四角缺了」。
 */
import { BrowserWindow } from 'electron';
import type { CaptureTarget } from '@clipchan/core';

/** 开发期走 Vite dev server 时，某块显示器的 overlay 页面地址。 */
export function overlayUrlFor(devServerUrl: string, displayId: number): string {
  return devServerUrl + '/capture.html?display=' + displayId;
}

export interface CreateOverlayOpts {
  /** 本次截图涉及的全部显示器（底图已经在里面，见铁律二「先抓后铺」）。 */
  targets: CaptureTarget[];
  preload: string;
  /** 开发期：Vite dev server 根地址（不带末尾斜杠）。 */
  devServerUrl?: string;
  /** 生产：打包好的 capture.html 绝对路径。 */
  file?: string;
}

/**
 * 每块显示器建一个全屏 overlay 窗。
 *
 * 显示器有几块就建几个窗 —— 单窗跨屏做不到：Windows 上一个 HWND 只能有一份
 * 内容，多屏拼起来的坐标系与各自的 scaleFactor 不一致，底图会对不齐。
 */
export function createOverlayWindows(opts: CreateOverlayOpts): BrowserWindow[] {
  const wins: BrowserWindow[] = [];
  for (const target of opts.targets) {
    const win = new BrowserWindow({
      x: target.bounds.x,
      y: target.bounds.y,
      width: target.bounds.width,
      height: target.bounds.height,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#000000',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // 关沙箱：overlay 要从 preload 拿 capture.target 的底图，与主窗口保持同一套
        // preload 环境（主窗口也是 sandbox:false），两套会让 IPC 行为不一致。
        sandbox: false,
        spellcheck: false,
        preload: opts.preload,
      },
    });
    // ★ 必须再 setBounds 一次：new BrowserWindow 的 height 会被系统夹到**工作区**高度
    //   （实测 1920x1080 建出来 getBounds 是 1920x1040，少了任务栏那 40px），
    //   而截图要能框到屏幕最下面一行像素。setBounds 之后再 getBounds 才是全屏，
    //   且 loadURL 之后不会被夹回去。
    win.setBounds({
      x: target.bounds.x,
      y: target.bounds.y,
      width: target.bounds.width,
      height: target.bounds.height,
    });
    // 'screen-saver' 层级才能盖住任务栏与其它置顶窗 —— 普通 'alwaysOnTop' 会被
    // 系统任务栏挡住底部一条，而截图要能框到屏幕最下面一行像素。
    win.setAlwaysOnTop(true, 'screen-saver');
    if (opts.devServerUrl) {
      void win.loadURL(overlayUrlFor(opts.devServerUrl, target.displayId));
    } else if (opts.file) {
      // 用 query 而不是拼 hash：渲染层读的是 location.search 的 display 参数。
      void win.loadFile(opts.file, { query: { display: String(target.displayId) } });
    }
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    wins.push(win);
  }
  return wins;
}

/** 关掉全部 overlay 窗（截图结束 / 取消 / 出错都要走到这里）。 */
export function closeOverlays(wins: BrowserWindow[]): void {
  for (const w of wins) {
    if (!w.isDestroyed()) w.destroy();
  }
}
