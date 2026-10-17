const EMPTY_TEXT = '(空白文本)';

/** 把文本压成单行预览：换行/制表压成空格、合并连续空格、按长度截断。 */
export function previewOfText(text: string, maxLen = 200): string {
  let s = text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (s.length === 0) return EMPTY_TEXT;
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

/**
 * 图片的"预览文本"。
 * ★ 必须与 db.ts 里 SQL 现场拼出的描述逐字一致，否则搜索图片会失效。
 */
export function previewOfImage(width: number, height: number, bytes: number): string {
  const kb = Math.floor(bytes / 1024);
  return '图片 ' + width + '×' + height + ' · ' + kb + ' KB';
}
