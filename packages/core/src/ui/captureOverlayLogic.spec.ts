/**
 * 截图 overlay 纯逻辑单测。
 *
 * 仓库的 vitest 只跑 node 环境、没有 jsdom（见 keymap.spec.ts 的文件头），
 * 所以 CaptureOverlay.tsx 本身渲染不了；这里断言的是从组件里抽出来的几何与
 * 状态函数，组件只负责把结果画到 canvas 上。
 */
import { describe, expect, it } from 'vitest';
import {
  COLORS,
  SHAPE_LIMIT,
  TOOLS,
  captureHintKey,
  mosaicBlocks,
  normalizeSel,
  popShape,
  pushShape,
  resizeHandleAt,
  selectionValid,
} from './captureOverlayLogic';
import type { Sel, Shape } from './captureOverlayLogic';

const shape = (tool: Shape['tool'] = 'rect'): Shape => ({ tool, color: '#ff3b30', points: [{ x: 0, y: 0 }] });

describe('TOOLS / COLORS', () => {
  it('五个工具，顺序固定（工具条按这个顺序渲染）', () => {
    expect(TOOLS.map((t) => t.key)).toEqual(['rect', 'arrow', 'pen', 'text', 'mosaic']);
    expect(TOOLS.map((t) => t.label)).toEqual(['矩形', '箭头', '画笔', '文字', '马赛克']);
  });

  it('六个颜色，首个是红（默认色）', () => {
    expect(COLORS).toHaveLength(6);
    expect(COLORS[0]).toBe('#ff3b30');
    expect(new Set(COLORS).size).toBe(6);
  });
});

describe('normalizeSel', () => {
  it('正向拖拽：起点就是按下点', () => {
    expect(normalizeSel({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('反向拖拽（从右下往左上）：起点取 min，宽高取绝对值', () => {
    expect(normalizeSel({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('混合方向（右上往左下）也归一', () => {
    expect(normalizeSel({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('零面积：点一下没拖动，宽高都是 0', () => {
    expect(normalizeSel({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe('selectionValid', () => {
  it('宽高都到 1 才算有效选区', () => {
    expect(selectionValid({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(selectionValid({ x: 0, y: 0, width: 100, height: 1 })).toBe(true);
  });

  it('任一边小于 1 视为误触（点一下不应弹工具条）', () => {
    expect(selectionValid({ x: 0, y: 0, width: 0, height: 10 })).toBe(false);
    expect(selectionValid({ x: 0, y: 0, width: 10, height: 0.5 })).toBe(false);
  });
});

describe('pushShape', () => {
  it('正常入栈，新的在末尾（重绘按顺序覆盖）', () => {
    const a = shape('rect');
    const b = shape('arrow');
    expect(pushShape([], a)).toEqual([a]);
    expect(pushShape([a], b)).toEqual([a, b]);
  });

  it('到上限后再加就丢最旧的那个', () => {
    const full: Shape[] = Array.from({ length: SHAPE_LIMIT }, (_, i) => ({ tool: 'pen', color: '#000000', points: [{ x: i, y: i }] }));
    const next = shape('rect');
    const out = pushShape(full, next);
    expect(out).toHaveLength(SHAPE_LIMIT);
    expect(out[out.length - 1]).toBe(next);
    expect(out[0]?.points[0]?.x).toBe(1);
  });

  it('自定义上限（limit 参数）也生效', () => {
    const out = pushShape([shape('rect'), shape('rect')], shape('arrow'), 2);
    expect(out).toHaveLength(2);
    expect(out[1]?.tool).toBe('arrow');
  });

  it('不修改原数组（撤销要能拿到旧栈）', () => {
    const base = [shape('rect')];
    pushShape(base, shape('arrow'));
    expect(base).toHaveLength(1);
  });
});

describe('popShape', () => {
  it('弹出最后一个', () => {
    const a = shape('rect');
    const b = shape('arrow');
    expect(popShape([a, b])).toEqual([a]);
  });

  it('空栈返回空数组，不抛（撤销键可能连按）', () => {
    expect(popShape([])).toEqual([]);
  });

  it('不修改原数组', () => {
    const base = [shape('rect')];
    popShape(base);
    expect(base).toHaveLength(1);
  });
});

describe('mosaicBlocks', () => {
  it('整除：正好切成 cell 见方', () => {
    const out = mosaicBlocks({ x: 0, y: 0, width: 20, height: 10 }, 10);
    expect(out).toHaveLength(2);
    expect(out).toEqual([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 10, y: 0, width: 10, height: 10 },
    ]);
  });

  it('非整除：最后一列/行取剩余宽度（不是固定 cell）', () => {
    const out = mosaicBlocks({ x: 0, y: 0, width: 25, height: 15 }, 10);
    expect(out).toHaveLength(6);
    expect(out[2]).toEqual({ x: 20, y: 0, width: 5, height: 10 });
    expect(out[5]).toEqual({ x: 20, y: 10, width: 5, height: 5 });
  });

  it('块从选区左上角起算（带偏移的选区）', () => {
    const out = mosaicBlocks({ x: 100, y: 200, width: 10, height: 20 }, 10);
    expect(out).toEqual([
      { x: 100, y: 200, width: 10, height: 10 },
      { x: 100, y: 210, width: 10, height: 10 },
    ]);
  });

  it('选区比一格还小：整块就是选区本身', () => {
    expect(mosaicBlocks({ x: 3, y: 4, width: 6, height: 7 }, 10)).toEqual([{ x: 3, y: 4, width: 6, height: 7 }]);
  });

  it('零面积选区不产生块（不画无意义的马赛克）', () => {
    expect(mosaicBlocks({ x: 0, y: 0, width: 0, height: 0 }, 10)).toEqual([]);
  });
});

describe('resizeHandleAt', () => {
  const sel: Sel = { x: 100, y: 100, width: 200, height: 100 };

  it('四个角各命中一次', () => {
    expect(resizeHandleAt({ x: 100, y: 100 }, sel)).toBe('nw');
    expect(resizeHandleAt({ x: 300, y: 100 }, sel)).toBe('ne');
    expect(resizeHandleAt({ x: 100, y: 200 }, sel)).toBe('sw');
    expect(resizeHandleAt({ x: 300, y: 200 }, sel)).toBe('se');
  });

  it('容差范围内也算命中', () => {
    expect(resizeHandleAt({ x: 107, y: 93 }, sel)).toBe('nw');
    expect(resizeHandleAt({ x: 293, y: 207 }, sel)).toBe('se');
  });

  it('选区中心不命中任何角（否则拖里面会变成缩放）', () => {
    expect(resizeHandleAt({ x: 200, y: 150 }, sel)).toBeNull();
  });

  it('容差边界：正好等于 tolerance 算命中，超一点不算', () => {
    expect(resizeHandleAt({ x: 100 - 8, y: 100 - 8 }, sel)).toBe('nw');
    expect(resizeHandleAt({ x: 100 - 9, y: 100 - 9 }, sel)).toBeNull();
  });

  it('自定义 tolerance 生效', () => {
    expect(resizeHandleAt({ x: 100 - 20, y: 100 - 20 }, sel, 20)).toBe('nw');
    expect(resizeHandleAt({ x: 100 - 20, y: 100 - 20 }, sel, 8)).toBeNull();
  });

  it('贴边但不靠角（比如上边中点）不命中', () => {
    expect(resizeHandleAt({ x: 200, y: 100 }, sel)).toBeNull();
  });
});

describe('captureHintKey', () => {
  it('Escape 取消', () => {
    expect(captureHintKey({ key: 'Escape' })).toBe('cancel');
  });

  it('Enter 确认（默认动作是复制）', () => {
    expect(captureHintKey({ key: 'Enter' })).toBe('confirm');
  });

  it('Ctrl+Z 撤销', () => {
    expect(captureHintKey({ key: 'z', ctrlKey: true })).toBe('undo');
  });

  it('不带 Ctrl 的 z 不撤销（画笔要用到 z 之外的键，别误触）', () => {
    expect(captureHintKey({ key: 'z' })).toBeNull();
    expect(captureHintKey({ key: 'z', ctrlKey: false })).toBeNull();
  });

  it('其它键一律 null', () => {
    for (const key of ['a', 'Shift', ' ', 'Backspace', 'ArrowLeft']) {
      expect(captureHintKey({ key })).toBeNull();
    }
  });
});
