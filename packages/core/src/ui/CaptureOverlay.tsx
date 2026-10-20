import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as RMouseEvent, PointerEvent as RPointerEvent } from 'react';
import type { CaptureAction, CaptureTarget, ClipchanApi } from '../types';
import {
  COLORS,
  TOOLS,
  captureHintKey,
  mosaicBlocks,
  normalizeSel,
  popShape,
  pushShape,
  resizeHandleAt,
  selectionValid,
} from './captureOverlayLogic';
import type { Point, Sel, Shape, Tool } from './captureOverlayLogic';

/**
 * 截图 overlay 页面（计划 §1 铁律一 / §3 T3）。
 *
 * ★ 为什么是独立页面而不是 App 里的一个 View：overlay 是「每显示器一个全屏无边框
 *   置顶窗」，主窗口那套布局与圆角裁切完全不适用（见 overlay.ts 的文件头）。所以
 *   它自己一个入口（capture.html），View 成员一个都不新增。
 * ★ 为什么不在这里 getPlatform()：与 OptimizeViewCard 同风格，平台能力由挂载点
 *   （capture.tsx）注入。区别只是 capture.tsx 是独立入口，它自己取一次再传下来。
 * ★ 为什么用 Pointer Events 而不是 mouse 事件：触控板/触屏/笔都要能框选，
 *   setPointerCapture 还能保证指针滑出窗口后仍收到 move（拖到屏幕边缘很常见）。
 * ★ 为什么选区遮罩用 box-shadow 而不是四个 div：四个 div 要在每次 resize 时重新
 *   计算四条边的宽高，而 box-shadow 的 9999px 扩散只需跟着选区矩形走，少一处
 *   容易算错的地方。
 */

const MASK = 'rgba(0,0,0,.45)';
const TOOLBAR_HEIGHT = 46;
const TOOLBAR_WIDTH = 470;
const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 四个角拖动 → 新选区（起点/宽高统一走 normalizeSel，反向拖也正确）。 */
function resizeSel(origin: Sel, handle: 'nw' | 'ne' | 'sw' | 'se', p: Point): Sel {
  let x1 = origin.x;
  let y1 = origin.y;
  let x2 = origin.x + origin.width;
  let y2 = origin.y + origin.height;
  if (handle === 'nw') {
    x1 = p.x;
    y1 = p.y;
  } else if (handle === 'ne') {
    x2 = p.x;
    y1 = p.y;
  } else if (handle === 'sw') {
    x1 = p.x;
    y2 = p.y;
  } else {
    x2 = p.x;
    y2 = p.y;
  }
  return normalizeSel({ x: x1, y: y1 }, { x: x2, y: y2 });
}

/**
 * 马赛克：把选区按 mosaicBlocks 切块，每块取底图对应区域的平均色填实。
 * 为什么要读像素而不是直接把小块放大：放大只是模糊，用户要的是「看不清原文」，
 * 纯色块才真的不可逆。
 */
function drawMosaic(ctx: CanvasRenderingContext2D, img: HTMLImageElement, box: Sel, scale: number, cell = 10): void {
  const blocks = mosaicBlocks(box, cell);
  if (blocks.length === 0) return;
  const cols = Math.max(1, Math.ceil(box.width / cell));
  const rows = Math.max(1, Math.ceil(box.height / cell));
  const tmp = document.createElement('canvas');
  tmp.width = cols;
  tmp.height = rows;
  const tctx = tmp.getContext('2d');
  if (!tctx) return;
  tctx.imageSmoothingEnabled = true;
  // 源矩形用设备像素（底图是 scale 倍大小的原图），目标只有 cols×rows，等于一次降采样。
  tctx.drawImage(img, box.x * scale, box.y * scale, box.width * scale, box.height * scale, 0, 0, cols, rows);
  let data: Uint8ClampedArray | null = null;
  try {
    data = tctx.getImageData(0, 0, cols, rows).data;
  } catch {
    // 取不到像素（极端情况下的画布污染）就退回放大绘制，至少让原文看不清。
    data = null;
  }
  if (!data) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, cols, rows, box.x, box.y, box.width, box.height);
    ctx.imageSmoothingEnabled = true;
    return;
  }
  for (const b of blocks) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((b.x - box.x) / cell)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((b.y - box.y) / cell)));
    const i = (row * cols + col) * 4;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const bl = data[i + 2] ?? 0;
    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + bl + ')';
    ctx.fillRect(b.x, b.y, b.width, b.height);
  }
}

/** 画一个标注。坐标一律是 CSS 像素（两个画布都先 scale 过），导出与预览共用同一套。 */
function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, img: HTMLImageElement | null, scale: number): void {
  const first = shape.points[0];
  if (!first) return;
  const last = shape.points[shape.points.length - 1] ?? first;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  if (shape.tool === 'pen') {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of shape.points) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (shape.tool === 'rect') {
    const box = normalizeSel(first, last);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  } else if (shape.tool === 'mosaic') {
    if (img) drawMosaic(ctx, img, normalizeSel(first, last), scale);
  } else if (shape.tool === 'arrow') {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const head = 14;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(last.x - head * Math.cos(angle - Math.PI / 7), last.y - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(last.x - head * Math.cos(angle + Math.PI / 7), last.y - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (shape.tool === 'text' && shape.text) {
    ctx.font = '600 18px ' + FONT_STACK;
    ctx.textBaseline = 'top';
    // 先描一圈深色再填色：底图可能是白底也可能是黑底，单色文字总有一半看不见。
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.strokeText(shape.text, first.x, first.y);
    ctx.fillStyle = shape.color;
    ctx.fillText(shape.text, first.x, first.y);
  }
  ctx.restore();
}

export interface CaptureOverlayProps {
  /** 由 capture.tsx 注入（组件自己不取平台，便于静态检查与复用）。 */
  platform: ClipchanApi;
}

export function CaptureOverlay({ platform }: CaptureOverlayProps): JSX.Element {
  const [target, setTarget] = useState<CaptureTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);
  const [sel, setSel] = useState<Sel | null>(null);
  const [dragSel, setDragSel] = useState<Sel | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [stroke, setStroke] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState<string>(COLORS[0] ?? '#ff3b30');
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStartRef = useRef<Point | null>(null);
  const resizeRef = useRef<{ handle: 'nw' | 'ne' | 'sw' | 'se'; origin: Sel } | null>(null);
  const displayIdRef = useRef(0);

  // 挂载时按 ?display= 要这一块屏幕的底图（铁律二：主进程已经抓完了才建窗）。
  useEffect(() => {
    const raw = new URLSearchParams(location.search).get('display');
    const id = Number(raw);
    displayIdRef.current = Number.isFinite(id) ? id : 0;
    let alive = true;
    platform.capture
      .target(displayIdRef.current)
      .then((t) => {
        if (!alive) return;
        if (t) setTarget(t);
        else {
          setError('没有拿到这块屏幕的截图，请重新发起截图。');
          void platform.capture.cancel();
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError('读取截图失败：' + errText(e));
        void platform.capture.cancel();
      });
    return () => {
      alive = false;
    };
  }, [platform]);

  // 画布按设备像素放大，笔迹才不糊；绘制代码仍用 CSS 像素（下面统一 scale）。
  useEffect(() => {
    if (!target) return;
    const fit = () => {
      const c = canvasRef.current;
      if (!c) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      c.width = Math.max(1, Math.round(w * target.scaleFactor));
      c.height = Math.max(1, Math.round(h * target.scaleFactor));
      setSize({ w, h });
      const img = imgRef.current;
      // 底图的真实倍率以「原图宽 / 显示宽」为准：窗口尺寸与抓图尺寸偶尔差一两像素
      // （DPI 取整），用 scaleFactor 直接算会让导出图错位。
      if (img && img.naturalWidth > 0 && img.clientWidth > 0) setScale(img.naturalWidth / img.clientWidth);
      else setScale(target.scaleFactor);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [target]);

  // 任何一处状态变了就整层重绘：标注量被 SHAPE_LIMIT 限死，重绘成本可忽略。
  useEffect(() => {
    const c = canvasRef.current;
    const t = target;
    if (!c || !t) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.scale(scale, scale);
    const img = imgRef.current;
    for (const s of shapes) drawShape(ctx, s, img, scale);
    if (stroke) drawShape(ctx, stroke, img, scale);
    const box = dragSel ?? sel;
    if (box && selectionValid(box)) {
      ctx.save();
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1);
      ctx.restore();
    }
  }, [target, shapes, stroke, sel, dragSel, size, scale, ready]);

  const finish = useCallback(
    async (action: CaptureAction) => {
      const t = target;
      const img = imgRef.current;
      const box = sel;
      if (busy || !t || !img || !box || !selectionValid(box)) return;
      setBusy(true);
      try {
        const out = document.createElement('canvas');
        // 导出尺寸 = 选区 CSS 尺寸 × 倍率，否则高分屏上存下来的图是糊的。
        out.width = Math.max(1, Math.round(box.width * scale));
        out.height = Math.max(1, Math.round(box.height * scale));
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('离屏画布不可用');
        ctx.drawImage(
          img,
          box.x * scale,
          box.y * scale,
          box.width * scale,
          box.height * scale,
          0,
          0,
          out.width,
          out.height,
        );
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(-box.x, -box.y);
        for (const s of shapes) drawShape(ctx, s, img, scale);
        ctx.restore();
        const pngDataUrl = out.toDataURL('image/png');
        const result = await platform.capture.finish({ displayId: t.displayId, pngDataUrl, action });
        if (!result.ok) {
          setError(result.reason ?? '处理截图失败，请重试。');
          setBusy(false);
        }
        // ok 时主进程会销毁 overlay 窗，这里不再改状态（否则卸载后 setState 警告）。
      } catch (e: unknown) {
        setError('合成截图失败：' + errText(e));
        setBusy(false);
      }
    },
    [busy, target, sel, shapes, scale, platform],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textDraft) return;
      const hint = captureHintKey({ key: e.key, ctrlKey: e.ctrlKey });
      if (hint === 'cancel') {
        e.preventDefault();
        void platform.capture.cancel();
      } else if (hint === 'confirm') {
        e.preventDefault();
        void finish('copy');
      } else if (hint === 'undo') {
        e.preventDefault();
        setShapes((prev) => popShape(prev));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [platform, textDraft, finish]);

  const pointOf = (e: RPointerEvent<HTMLDivElement>): Point => ({ x: e.clientX, y: e.clientY });

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (busy || !ready || !target || e.button !== 0) return;
    const p = pointOf(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (sel) {
      const handle = resizeHandleAt(p, sel);
      if (handle) {
        resizeRef.current = { handle, origin: sel };
        return;
      }
      // 选区外按下不重新框选（避免画到导出范围外），要换范围先右键清掉选区。
      if (p.x < sel.x || p.y < sel.y || p.x > sel.x + sel.width || p.y > sel.y + sel.height) return;
      if (tool === 'text') {
        setTextDraft({ x: p.x, y: p.y, value: '' });
        return;
      }
      setStroke({ tool, color, points: [p] });
      return;
    }
    dragStartRef.current = p;
    setDragSel({ x: p.x, y: p.y, width: 0, height: 0 });
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = pointOf(e);
    const resizing = resizeRef.current;
    if (resizing) {
      setSel(resizeSel(resizing.origin, resizing.handle, p));
      return;
    }
    const start = dragStartRef.current;
    if (start) {
      setDragSel(normalizeSel(start, p));
      return;
    }
    if (stroke) {
      setStroke((prev) => {
        if (!prev) return prev;
        const first = prev.points[0] ?? p;
        return { ...prev, points: prev.tool === 'pen' ? [...prev.points, p] : [first, p] };
      });
    }
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current) {
      resizeRef.current = null;
      return;
    }
    const start = dragStartRef.current;
    if (start) {
      const next = normalizeSel(start, pointOf(e));
      dragStartRef.current = null;
      setDragSel(null);
      setSel(selectionValid(next) ? next : null);
      return;
    }
    if (stroke) {
      const first = stroke.points[0];
      const last = stroke.points[stroke.points.length - 1];
      // 只点一下没拖动（rect/arrow/mosaic）不算一笔，否则会留下一堆看不见的标注。
      const degenerate = stroke.tool !== 'pen' && first && last && first.x === last.x && first.y === last.y;
      if (!degenerate) setShapes((prev) => pushShape(prev, stroke));
      setStroke(null);
    }
  };

  const onContextMenu = (e: RMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (sel) {
      // 有选区时右键只退一步（清选区），再右键才退出截图：手滑一下不该丢掉整张截图。
      // 标注不清 —— 重新框选后它们还在，用户不用重画。
      setSel(null);
      setStroke(null);
      return;
    }
    void platform.capture.cancel();
  };

  const commitText = () => {
    const draft = textDraft;
    setTextDraft(null);
    const value = draft ? draft.value.trim() : '';
    if (!draft || value === '') return;
    setShapes((prev) => pushShape(prev, { tool: 'text', color, points: [{ x: draft.x, y: draft.y }], text: value }));
  };

  const toolbarTop = sel
    ? sel.y + sel.height + 8 + TOOLBAR_HEIGHT > window.innerHeight
      ? Math.max(8, sel.y - TOOLBAR_HEIGHT - 8)
      : sel.y + sel.height + 8
    : 0;
  const toolbarLeft = sel ? Math.max(8, Math.min(sel.x, window.innerWidth - TOOLBAR_WIDTH - 8)) : 8;

  return (
    <div
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#000', cursor: 'crosshair' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
    >
      {target ? (
        <img
          ref={imgRef}
          src={target.dataUrl}
          alt=""
          className="absolute inset-0 h-full w-full select-none object-fill"
          draggable={false}
          onLoad={() => {
            const img = imgRef.current;
            if (img && img.naturalWidth > 0 && img.clientWidth > 0) setScale(img.naturalWidth / img.clientWidth);
            setReady(true);
          }}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
      ) : null}

      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />

      {/* 选区外压暗：一个 box-shadow 扩散 9999px 就是挖空，不用四条边各算一次。 */}
      {sel && selectionValid(sel) ? (
        <div
          style={{
            position: 'absolute',
            left: sel.x,
            top: sel.y,
            width: sel.width,
            height: sel.height,
            boxShadow: '0 0 0 9999px ' + MASK,
            outline: '1px solid #0a84ff',
            pointerEvents: 'none',
          }}
        />
      ) : dragSel && selectionValid(dragSel) ? (
        <div
          style={{
            position: 'absolute',
            left: dragSel.x,
            top: dragSel.y,
            width: dragSel.width,
            height: dragSel.height,
            boxShadow: '0 0 0 9999px ' + MASK,
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0, background: MASK, pointerEvents: 'none' }} />
      )}

      {textDraft ? (
        <input
          autoFocus
          value={textDraft.value}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setTextDraft({ x: textDraft.x, y: textDraft.y, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText();
            else if (e.key === 'Escape') setTextDraft(null);
            e.stopPropagation();
          }}
          onBlur={commitText}
          style={{
            position: 'absolute',
            left: textDraft.x,
            top: textDraft.y,
            minWidth: 120,
            padding: '2px 6px',
            font: '600 18px ' + FONT_STACK,
            color,
            background: 'rgba(0,0,0,.35)',
            border: '1px solid ' + color,
            borderRadius: 4,
            outline: 'none',
          }}
        />
      ) : null}

      {sel && selectionValid(sel) ? (
        <div
          style={{
            position: 'absolute',
            left: toolbarLeft,
            top: toolbarTop,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 8px',
            background: 'rgba(28,28,30,.96)',
            border: '1px solid rgba(255,255,255,.14)',
            borderRadius: 10,
            font: '13px ' + FONT_STACK,
            color: '#f5f5f7',
            cursor: 'default',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {TOOLS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTool(t.key)}
              style={{
                padding: '3px 8px',
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                background: tool === t.key ? '#0a84ff' : 'rgba(255,255,255,.1)',
                color: '#fff',
                font: '13px ' + FONT_STACK,
              }}
            >
              {t.label}
            </button>
          ))}
          <span style={{ width: 1, height: 20, background: 'rgba(255,255,255,.18)' }} />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={'颜色 ' + c}
              onClick={() => setColor(c)}
              style={{
                width: 18,
                height: 18,
                padding: 0,
                borderRadius: 9,
                cursor: 'pointer',
                background: c,
                border: color === c ? '2px solid #fff' : '2px solid transparent',
              }}
            />
          ))}
          <span style={{ width: 1, height: 20, background: 'rgba(255,255,255,.18)' }} />
          <button type="button" onClick={() => setShapes((prev) => popShape(prev))} style={btnStyle(false)}>
            撤销
          </button>
          <button type="button" disabled={busy} onClick={() => void finish('copy')} style={btnStyle(true)}>
            复制
          </button>
          <button type="button" disabled={busy} onClick={() => void finish('paste')} style={btnStyle(false)}>
            粘贴
          </button>
          <button type="button" disabled={busy} onClick={() => void finish('save')} style={btnStyle(false)}>
            存文件
          </button>
          <button type="button" onClick={() => void platform.capture.cancel()} style={btnStyle(false)}>
            取消
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%,-50%)',
            maxWidth: 420,
            padding: '18px 22px',
            borderRadius: 12,
            background: 'rgba(28,28,30,.96)',
            border: '1px solid rgba(255,255,255,.16)',
            color: '#f5f5f7',
            font: '14px/1.6 ' + FONT_STACK,
            textAlign: 'center',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>截图失败</div>
          <div style={{ color: '#c7c7cc' }}>{error}</div>
          <div style={{ marginTop: 8, color: '#8e8e93', fontSize: 12 }}>按 Esc 关闭</div>
        </div>
      ) : null}
    </div>
  );
}

function btnStyle(primary: boolean): Record<string, string | number> {
  return {
    padding: '3px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    border: 'none',
    background: primary ? '#0a84ff' : 'rgba(255,255,255,.1)',
    color: '#fff',
    font: '13px ' + FONT_STACK,
  };
}
