/**
 * 批量操作栏的纯逻辑（v0.6.0 / P2-8）。
 *
 * 按钮集合完全由「选中几条 / 是不是全都已收藏」决定，抽出来才能脱离 DOM 单测。
 */

export interface BatchAction {
  key: 'paste' | 'pin' | 'unpin' | 'remove';
  label: string;
  danger?: boolean;
}

/**
 * 选中集对应的按钮序列。0 条时返回空数组 —— 调用方据此决定要不要渲染整条操作栏。
 * ★ 收藏与取消收藏是同一个位置的两种形态：全都收藏了才给「取消收藏」，
 *   混合选择按「收藏」处理（对已收藏的再收藏是无害的幂等操作，反过来则会误取消）。
 */
export function batchActions(count: number, allPinned: boolean): BatchAction[] {
  if (count <= 0) return [];
  return [
    { key: 'paste', label: '粘贴为一条' },
    allPinned ? { key: 'unpin', label: '取消收藏' } : { key: 'pin', label: '收藏' },
    { key: 'remove', label: '删除', danger: true },
  ];
}

/** 操作栏左侧的计数文案；0 条返回空串（不显示「已选 0 条」这种废话）。 */
export function batchBarText(count: number): string {
  return count > 0 ? '已选 ' + count + ' 条' : '';
}

/** 删除按钮是否可用（条数为负 / 0 都不给点）。 */
export function canBatchRemove(count: number): boolean {
  return count > 0;
}
