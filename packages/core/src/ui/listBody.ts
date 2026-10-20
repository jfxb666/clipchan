import type { ClipItemDTO } from '../types';

/**
 * 三个布局视图（时间轴 / 瀑布流 / 按来源）共用的 props。
 *
 * ★ 单独抽一个文件而不是从 ListPanel 导出：ListPanel 要 import 这三个视图组件，
 *   视图组件又要拿 ListPanel 的 props 类型 —— 放一起就是循环 import。
 */
export interface ListBodyProps {
  items: ClipItemDTO[];
  selectedIds: string[];
  term: string;
  onSelect: (id: string, opts?: { multi?: boolean }) => void;
  onPaste: (id: string) => void;
  onTogglePin: (id: string) => void;
  onHover?: (id: string | null) => void;
  onOptimize?: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
}
