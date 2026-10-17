import { useCallback, useRef } from 'react';
import { cn } from './util';

/**
 * 自绘缩放手柄（spec §6.6）。
 *
 * ★ 为什么不用系统边框：窗口是 `frame:false`，没有系统边框可拖（spec §6.6 实测
 *   `frame` 只能在创建时定）。所以右缘 / 下缘 / 右下角各放一个不可拖拽区
 *   （`cc-no-drag`），pointermove 的位移换算成 `app.resizeBy(dw,dh)` 发给主进程。
 *
 * 两种形态：
 * - main：右缘改宽、下缘改高、右下角同时改（720×480 ~ 1200×900，夹取在主进程）；
 * - widget：只有右缘/右下角，宽度拖拽时只改窗口尺寸，松手才持久化到设置里。
 *
 * ★ 拖拽手感（用户反馈「拖拽的手感很一般」）的三个关键点：
 *   1. 每帧只发**这一帧的增量**（旧代码发的是"从按下起的累计位移"，主进程按增量
 *      叠加 → 位移被重复累加，越拖越快）；
 *   2. 拖拽中主进程**不重设窗口形状**（setShape 要下发 30+ 个矩形，逐帧调用很贵），
 *      松手时再补一次圆角；
 *   3. 小组件宽度**松手才写设置**（拖拽中写 settings 表 + 广播会卡）。
 *
 * ★ 不要用 requestAnimationFrame 合帧（踩过的坑）：本机应用窗口经常被别的置顶窗口
 *   盖住，Chromium 认为页面不可见时 rAF 会**完全停摆** —— 拖拽直接失效。
 *   指针事件本身照常送达，所以这里直接发（Chromium 已把 pointermove 合并到刷新率）。
 */
export const MAIN_MIN_WIDTH = 720;
export const MAIN_MIN_HEIGHT = 480;
export const MAIN_MAX_WIDTH = 1200;
export const MAIN_MAX_HEIGHT = 900;
export const WIDGET_MIN_WIDTH = 240;
export const WIDGET_MAX_WIDTH = 400;

export type ResizeHandleKind = 'right' | 'bottom' | 'corner';

/** 夹取小组件宽度（与主进程 windows.ts / frosted.ts 的 240–400 一致）。 */
export function clampWidgetWidth(px: number): number {
  if (!Number.isFinite(px)) return WIDGET_MIN_WIDTH;
  return Math.min(WIDGET_MAX_WIDTH, Math.max(WIDGET_MIN_WIDTH, Math.round(px)));
}

interface DragState {
  kind: ResizeHandleKind;
  /** 上一次 pointermove 的视口坐标（每帧更新，用来算**增量**）。 */
  x: number;
  y: number;
  /** 小组件：拖拽起点宽度 + 累计位移后的目标宽度（松手时持久化用）。 */
  width: number;
  /** 本次拖拽是否真的动过（没动过就不用补圆角 / 写设置）。 */
  moved: boolean;
}

export function ResizeHandles({
  mode,
  onResizeBy,
  onWidgetWidth,
  className,
}: {
  mode: 'main' | 'widget';
  /** 主窗口：按增量改尺寸（主进程负责夹取）。shape=false 表示拖拽中，先不重设圆角。 */
  onResizeBy: (dw: number, dh: number, shape?: boolean) => void;
  /** 小组件：按绝对宽度改（主进程负责持久化 + 夹取）。 */
  onWidgetWidth: (px: number) => void;
  className?: string;
}) {
  const drag = useRef<DragState | null>(null);

  const onPointerDown = useCallback(
    (kind: ResizeHandleKind) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 某些环境下拿不到指针捕获，退化为普通拖拽，不影响功能。
      }
      drag.current = { kind, x: event.clientX, y: event.clientY, width: window.innerWidth, moved: false };
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state) return;
      // 只发**这一帧的增量**，发完把基准点挪到当前位置。
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      if (dx === 0 && dy === 0) return;
      state.x = event.clientX;
      state.y = event.clientY;
      state.moved = true;
      if (mode === 'widget') {
        // 小组件只有宽度可调（高度按内容自适应）。
        // 宽度用累计值算，避免依赖主进程回写的 window.innerWidth。
        state.width = clampWidgetWidth(state.width + dx);
        onResizeBy(dx, 0, false);
        return;
      }
      onResizeBy(state.kind === 'bottom' ? 0 : dx, state.kind === 'right' ? 0 : dy, false);
    },
    [mode, onResizeBy],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      drag.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // 没捕获成功就不用释放。
      }
      if (!state || !state.moved) return;
      if (mode === 'widget') {
        // 松手才持久化宽度（拖拽中写设置会卡）。
        onWidgetWidth(clampWidgetWidth(state.width));
      }
      // 补一次圆角（拖拽中为了流畅没重设 setShape）。
      onResizeBy(0, 0, true);
    },
    [mode, onResizeBy, onWidgetWidth],
  );

  const handleProps = (kind: ResizeHandleKind) => ({
    onPointerDown: onPointerDown(kind),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  });

  const showBottom = mode === 'main';

  return (
    <>
      <div
        {...handleProps('right')}
        title="拖动调整宽度"
        className={cn('cc-no-drag absolute right-0 top-[38px] z-40 h-[calc(100%-38px)] w-[6px] cursor-col-resize', className)}
      />
      {showBottom ? (
        <div
          {...handleProps('bottom')}
          title="拖动调整高度"
          className={cn('cc-no-drag absolute bottom-0 left-0 z-40 h-[6px] w-full cursor-row-resize', className)}
        />
      ) : null}
      <div
        {...handleProps('corner')}
        title="拖动调整大小"
        className={cn('cc-no-drag absolute bottom-0 right-0 z-40 h-[14px] w-[14px] cursor-nwse-resize', className)}
      >
        <svg viewBox="0 0 14 14" className="h-full w-full text-ink-3 opacity-50" aria-hidden>
          <path d="M13 5 L5 13 M13 9 L9 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
    </>
  );
}
