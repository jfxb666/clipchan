import type { Snippet } from '../types';

/**
 * 片段库的纯逻辑（v0.6.0 / P1-6）。
 *
 * ★ 为什么单独抽一个文件：仓库测试跑在 node 环境（无 jsdom），能测的只有纯函数。
 *   组件 SnippetView.tsx 只负责渲染，所有兜底 / 校验 / 排序都在这里。
 */

/** 标题上限（字符）：超出由 validateSnippet 拦下，输入框也用它做 maxLength。 */
export const SNIPPET_TITLE_MAX = 60;
/** 内容上限（字符）：与主进程的入库校验同一口径。 */
export const SNIPPET_CONTENT_MAX = 20000;
/** 删除的二次确认存活时长：与回收站 / Ctrl+Delete 同一节奏（3 秒）。 */
export const SNIPPET_CONFIRM_TTL_MS = 3000;

/** 没有标题也没有可用首行时的兜底名。 */
const UNNAMED = '未命名片段';

/**
 * 相对时间（只给四档 + 未来时间的兜底，共五档）。
 * ★ 不直接用 util 的 formatTime：那边给的是「昨天 14:03」这种绝对时间，
 *   而片段列表要回答的是"我多久没动过它"，相对时间更直观。
 */
function relativeTime(ts: number, now: number): string {
  const diff = now - ts;
  // 系统时间回拨 / 时钟漂移会算出负数：一律当作「刚刚」，不显示「-3 分钟前」。
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  return Math.floor(diff / 86_400_000) + ' 天前';
}

/**
 * 列表上显示的名字：标题优先，其次内容首行，最后兜底。
 * 首行同样要截断 —— 有人把一整段代码存成片段，不截的话标题会撑爆一行。
 */
export function snippetLabel(s: { title: string; content: string }): string {
  const title = s.title.trim();
  if (title !== '') return title;
  const firstLine = (s.content.split('\n')[0] ?? '').trim();
  if (firstLine !== '') return firstLine.slice(0, SNIPPET_TITLE_MAX);
  return UNNAMED;
}

/** 预览：先压成单行（换行在列表里只会浪费一行高度），再截断加省略号。 */
export function snippetPreview(content: string, max = 120): string {
  const flat = content.replace(/\r\n|\r|\n/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '…';
}

/**
 * 保存前校验：返回中文错误串，null 表示可以存。
 * 顺序固定（空 -> 太长 -> 标题太长）：内容为空是最高优先级的错，先报它。
 */
export function validateSnippet(input: { title: string; content: string }): string | null {
  if (input.content.trim() === '') return '片段内容不能为空';
  if (input.content.length > SNIPPET_CONTENT_MAX) return '片段内容太长';
  if (input.title.length > SNIPPET_TITLE_MAX) return '标题太长';
  return null;
}

/** 元信息行：「用过 3 次 · 3 天前」。 */
export function snippetMeta(s: { useCount: number; updatedAt: number }, now: number): string {
  const used = s.useCount > 0 ? '用过 ' + s.useCount + ' 次' : '还没用过';
  return used + ' · ' + relativeTime(s.updatedAt, now);
}

/**
 * 最近改过的靠前；同一毫秒按 id 倒序（新建的 id 更大，等于"新的在上"）。
 * ★ 返回新数组：调用方拿到的 list 常常直接来自 store，就地排序会改到 React 的 state。
 */
export function sortSnippets(list: Snippet[]): Snippet[] {
  return [...list].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  });
}

/** 空状态文案：顺带说明片段是用来干什么的（比"暂无数据"有用）。 */
export function emptySnippetHint(): string {
  return '还没有片段。把常贴的地址、话术、命令存成片段，以后一键粘贴。';
}
