export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * 把预览文本按搜索词切成「命中 / 未命中」片段，供卡片渲染 <mark>。
 *
 * 规则：term 只去首尾空白、不按空格拆词（搜索走的是整串 LIKE，高亮必须与之一致，
 * 否则用户会看到高亮了但列表里其实没匹配的条目）。大小写不敏感定位、保留原文大小写；
 * 片段不重叠且完整覆盖原文，拼接回去必须等于 text。
 */
export function highlightSegments(text: string, term: string): HighlightSegment[] {
  const needle = term.trim();
  if (!text) return [];
  if (!needle) return [{ text, hit: false }];

  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let found = haystack.indexOf(lower);
  while (found !== -1) {
    if (found > cursor) segments.push({ text: text.slice(cursor, found), hit: false });
    segments.push({ text: text.slice(found, found + needle.length), hit: true });
    cursor = found + needle.length;
    found = haystack.indexOf(lower, cursor);
  }
  if (segments.length === 0) return [{ text, hit: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
