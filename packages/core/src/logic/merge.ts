import type { Kind } from '../types';

export interface MergeInput {
  content: string | null;
  pinned: boolean;
  kind: Kind;
}

/**
 * 按列表顺序把多条文本拼成一条。收藏项与图片项被跳过（与旧版
 * legacy/src/MainForm.cs MergeSelected 的语义一致：收藏项不参与、图片不参与）。
 * 去掉这两类后不足 2 条时返回 null，调用方据此提示"拼接需要至少 2 条未收藏记录"。
 */
export function mergeTexts(
  items: MergeInput[],
  sep = '\r\n',
): { text: string; skippedImages: number } | null {
  const parts: string[] = [];
  let skippedImages = 0;
  for (const it of items) {
    if (it.pinned) continue;
    if (it.kind === 'image' || it.content === null) { skippedImages++; continue; }
    parts.push(it.content);
  }
  if (parts.length < 2) return null;
  return { text: parts.join(sep), skippedImages };
}
