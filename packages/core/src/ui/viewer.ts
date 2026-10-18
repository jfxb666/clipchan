/**
 * 全文 / 大图查看器的纯逻辑：决定打开哪一种浮层、标题叫什么。
 * preview 是可选的：调用方通常传完整条目，但只传 kind 也必须能判定。
 */

export type ViewerKind = 'image' | 'text' | 'none';

export interface ViewerSource {
  kind: string;
  thumbUrl?: string;
  truncated?: boolean;
  preview?: string;
}

/** 图片 → image；非图片且有可见内容 → text；其余 none。 */
export function viewerKindOf(item: ViewerSource | null | undefined): ViewerKind {
  if (!item) return 'none';
  if (item.kind === 'image') return 'image';
  const preview = typeof item.preview === 'string' ? item.preview.trim() : '';
  return preview.length > 0 ? 'text' : 'none';
}

export function viewerTitleOf(item: { kind: string; preview: string } | null | undefined): string {
  if (!item) return '';
  return item.kind === 'image' ? '图片' : '全文';
}
