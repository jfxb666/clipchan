/**
 * 右键菜单的纯逻辑：菜单项装配 + 视口钳位。
 * 单独抽出来的原因：仓库测试跑在 node 环境（无 jsdom），能测的只有纯函数。
 */

export type MenuAction = 'copy' | 'paste' | 'view' | 'optimize' | 'pin' | 'remove';

export interface MenuItem {
  action: MenuAction;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
}

/** 装配菜单项所需的卡片信息（与 ClipItemDTO 的对应字段同构）。 */
export interface MenuSource {
  kind: string;
  pinned: boolean;
  truncated?: boolean;
  hasFullText?: boolean;
}

const DEFAULT_MARGIN = 8;

/**
 * 固定顺序：view → copy → paste → optimize → pin → remove。
 * view 放最前是因为它只在「有更多内容可看」时出现，属于第一意图。
 */
export function menuItemsFor(item: MenuSource): MenuItem[] {
  const isImage = item.kind === 'image';
  const items: MenuItem[] = [];

  if (isImage || item.truncated === true || item.hasFullText === true) {
    items.push({ action: 'view', label: isImage ? '查看大图' : '查看全文' });
  }

  items.push({ action: 'copy', label: '复制到剪贴板' });
  items.push({ action: 'paste', label: '复制并粘贴' });

  if (!isImage) items.push({ action: 'optimize', label: '优化提示词' });

  items.push({ action: 'pin', label: item.pinned ? '取消收藏' : '收藏', hint: 'Ctrl+D' });
  items.push({ action: 'remove', label: '删除', danger: true });

  return items;
}

/**
 * 把菜单左上角钳进视口；下方放不下时上翻，翻上去仍越界再钳一次（不允许出负坐标）。
 * 视口小于菜单本身时以 margin 为下限，宁可溢出右/下边也不让左上角飞出屏幕。
 */
export function clampMenuPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number = DEFAULT_MARGIN,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);

  let left = Math.min(Math.max(x, margin), maxX);
  let top = Math.min(Math.max(y, margin), maxY);

  if (y + size.height > viewport.height - margin) {
    top = Math.min(Math.max(y - size.height, margin), maxY);
  }

  return { x: left, y: top };
}
