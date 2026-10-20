/**
 * 截图 overlay 的纯逻辑（计划 §3 T3）。
 *
 * ★ 为什么把几何与状态从 CaptureOverlay.tsx 里抽出来：仓库的 vitest 只跑 node、
 *   没有 jsdom，组件本身渲染不了（见 keymap.spec.ts 的文件头）。抽成不依赖 React
 *   的纯函数后，坐标归一、撤销栈、马赛克切块这些真正容易算错的地方才有单测。
 * ★ 文件名为什么是 captureOverlayLogic 而不是 captureOverlay：后者与组件
 *   CaptureOverlay.tsx 只差大小写，在大小写不敏感的文件系统上 TS 会把它俩解析成
 *   同一个文件（TS1149，见 OptimizeViewCard.tsx:23-29 的既有教训）。
 */

export type Tool = 'rect' | 'arrow' | 'pen' | 'text' | 'mosaic';

/** 工具条顺序即此顺序，别按字母重排。 */
export const TOOLS: { key: Tool; label: string }[] = [
  { key: 'rect', label: '矩形' },
  { key: 'arrow', label: '箭头' },
  { key: 'pen', label: '画笔' },
  { key: 'text', label: '文字' },
  { key: 'mosaic', label: '马赛克' },
];

/**
 * 六个高区分度颜色：红橙黄绿蓝紫。深色底图上黄色与绿色都还能看清，
 * 所以不选纯灰阶（截图底图什么颜色都可能有）。
 */
export const COLORS: string[] = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de'];

export interface Point {
  x: number;
  y: number;
}

export interface Sel {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 两次拖拽点 → 归一化选区。
 * 用户可以从任意方向拖（右下往左上、右上往左下），起点一律取 min、宽高取绝对值，
 * 否则后续的裁剪与工具条定位都要各自处理四种方向。
 */
export function normalizeSel(a: Point, b: Point): Sel {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export interface Shape {
  tool: Tool;
  color: string;
  points: Point[];
  /** 仅 tool === 'text' 时使用。 */
  text?: string;
}

/**
 * 标注栈上限。截图标注是"临时涂抹"，不是画板；无限堆积只会在合成时拖慢
 * 一次几千万像素的离屏 canvas 重绘，用户也早就看不清了。
 */
export const SHAPE_LIMIT = 50;

/** 入栈；到上限丢最旧的那个（最新的一笔永远保留）。返回新数组，撤销要能拿到旧栈。 */
export function pushShape(stack: Shape[], shape: Shape, limit = SHAPE_LIMIT): Shape[] {
  const next = [...stack, shape];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** 出栈；空栈返回空数组而不是抛——撤销键可以被连按，抛错会打断键盘处理。 */
export function popShape(stack: Shape[]): Shape[] {
  return stack.length === 0 ? [] : stack.slice(0, -1);
}

/** 宽高都到 1 才算有效选区：只点一下没拖动是误触，不该弹工具条。 */
export function selectionValid(sel: Sel): boolean {
  return sel.width >= 1 && sel.height >= 1;
}

/**
 * 把选区切成 cell 见方的小块，供马赛克逐块取样。
 * 最后一列/行取剩余宽度而不是固定 cell——否则非整除时马赛克会画到选区外面去。
 */
export function mosaicBlocks(sel: Sel, cell = 10): Sel[] {
  const blocks: Sel[] = [];
  if (sel.width <= 0 || sel.height <= 0) return blocks;
  for (let y = 0; y < sel.height; y += cell) {
    const h = Math.min(cell, sel.height - y);
    for (let x = 0; x < sel.width; x += cell) {
      const w = Math.min(cell, sel.width - x);
      blocks.push({ x: sel.x + x, y: sel.y + y, width: w, height: h });
    }
  }
  return blocks;
}

/**
 * 命中选区的四个缩放手柄。tolerance 是"手指友好的"容差：8px 内都算抓住角，
 * 手柄本身只有几像素，纯精确命中在触控板上几乎抓不住。
 */
export function resizeHandleAt(p: Point, sel: Sel, tolerance = 8): 'nw' | 'ne' | 'sw' | 'se' | null {
  const left = sel.x;
  const top = sel.y;
  const right = sel.x + sel.width;
  const bottom = sel.y + sel.height;
  const nearX = (edge: number) => Math.abs(p.x - edge) <= tolerance;
  const nearY = (edge: number) => Math.abs(p.y - edge) <= tolerance;
  const nearLeft = nearX(left);
  const nearRight = nearX(right);
  const nearTop = nearY(top);
  const nearBottom = nearY(bottom);
  if (nearLeft && nearTop) return 'nw';
  if (nearRight && nearTop) return 'ne';
  if (nearLeft && nearBottom) return 'sw';
  if (nearRight && nearBottom) return 'se';
  return null;
}

/**
 * 键盘提示 → 动作。Escape 取消、Enter 确认（默认动作是复制）、Ctrl+Z 撤销。
 * 不认裸 z：画笔工具下用户可能正想按快捷键切工具，裸字母留给后续扩展。
 */
export function captureHintKey(e: { key: string; ctrlKey?: boolean }): 'cancel' | 'confirm' | 'undo' | null {
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Enter') return 'confirm';
  if (e.ctrlKey === true && (e.key === 'z' || e.key === 'Z')) return 'undo';
  return null;
}
