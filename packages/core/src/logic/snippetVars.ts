/**
 * 片段变量展开（v1.2 C3）。
 *
 * ★ 模板原文不可变——变量是「使用时」语义：db 的 snippets 表里存的永远是模板原文，
 *   展开只发生在主进程「使用片段」的那一瞬间（main.ts 的 CH.snippets.use）。
 *   因此本函数是纯函数：时间与剪贴板文本都由调用方注入，这里不碰任何时钟/系统状态。
 */

/** 展开上下文：调用方在使用瞬间取值注入。 */
export interface SnippetExpandCtx {
  /** 使用瞬间的时间（按本地时区格式化）。 */
  now: Date;
  /** 使用瞬间剪贴板里的文本；剪贴板为空/读不到给空串——{{剪贴板}} 展开为空，不留字面占位。 */
  clipboard: string;
}

/** 本地时间 → YYYY-MM-DD（手拼，与 ui/util.ts 的 formatClock、export-import.ts 同款口径；仓库无日期库）。 */
function localDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 本地时间 → HH:mm。 */
function localTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 展开片段内容里的变量占位符。中英文写法等价：
 * `{{日期}}`/`{{date}}` → 当天日期，`{{时间}}`/`{{time}}` → 当前时:分，`{{剪贴板}}`/`{{clipboard}}` → 剪贴板文本。
 * 未知占位符原样保留（用户可能就在写模板文档，不能替他把「文档」改成别的）。
 */
export function expandSnippet(content: string, ctx: SnippetExpandCtx): string {
  // 快路径：绝大多数片段没有变量，连替换表都不用建。
  if (!content.includes('{{')) return content;
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ['{{日期}}', localDate(ctx.now)],
    ['{{date}}', localDate(ctx.now)],
    ['{{时间}}', localTime(ctx.now)],
    ['{{time}}', localTime(ctx.now)],
    ['{{剪贴板}}', ctx.clipboard],
    ['{{clipboard}}', ctx.clipboard],
  ];
  let out = content;
  for (const [placeholder, value] of replacements) {
    out = out.replaceAll(placeholder, value);
  }
  return out;
}
