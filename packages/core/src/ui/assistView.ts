import type { AssistRequest, AssistResult } from '../types';

/**
 * AI 助手面板的纯函数与常量（v1.0.0 第 ⑤ 项）。
 * 与 optimizeView.ts 同一处理：仓库没有 jsdom / testing-library（§2 约束），
 * 组件不可测，因此面板里所有可测逻辑都放进这个不依赖 React 的模块。
 */

/** 面板上列出的五个动作（顺序即按钮顺序）。 */
export interface AssistActionOption {
  id: AssistRequest['action'];
  /** 按钮文字。 */
  name: string;
  /** 鼠标悬停的一句解释。 */
  hint: string;
}

/** 顺序固定：翻译 / 总结 / 改写 / 解释 / 提取要点。 */
export const ASSIST_ACTION_OPTIONS: readonly AssistActionOption[] = [
  { id: 'translate', name: '翻译', hint: '译成另一种语言，只给译文' },
  { id: 'summarize', name: '总结', hint: '压成几句要点，去掉客套话' },
  { id: 'rewrite', name: '改写', hint: '保持原意重写一遍，让句子更顺' },
  { id: 'explain', name: '解释', hint: '讲清这段内容到底在说什么' },
  { id: 'extract', name: '提取要点', hint: '把关键信息逐条列出来' },
];

/** 目标语言（只有翻译用得到）。 */
export interface AssistLangOption {
  id: string;
  name: string;
}

export const ASSIST_LANG_OPTIONS: readonly AssistLangOption[] = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'en', name: '英文' },
  { id: 'ja', name: '日文' },
];

/** 该动作是否需要选目标语言：五个动作里只有翻译需要。 */
export function assistNeedsLang(action: AssistRequest['action']): boolean {
  return action === 'translate';
}

/**
 * 猜一个默认目标语言：原文以中文为主就给 'en'，否则给 'zh-CN'。
 * 逐字符计数而不是看首个字符——中英混排的段落开头常常是英文单词。
 */
export function defaultTargetLang(text: string): string {
  const han = text.match(/[\u4e00-\u9fa5]/g);
  const latin = text.match(/[A-Za-z]/g);
  const hanCount = han === null ? 0 : han.length;
  const latinCount = latin === null ? 0 : latin.length;
  return hanCount > latinCount ? 'en' : 'zh-CN';
}

/**
 * degraded=true 时的提示文案；false 时返回 ''（不显示黄条）。
 * 与 optimizeView 的 degradedHint 不同名导出时会被 index.ts 撞名，见 ui/index.ts 的注释。
 */
export function degradedHint(degraded: boolean): string {
  return degraded ? '模型没按格式返回，下面是原始回复，可能需要自己摘一下' : '';
}

/** 结果区的状态：idle 未跑过 / running 跑着 / done 有结果 / error 出错。 */
export type AssistStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * ★ error 优先于一切（先 trim 后判空）：出错时 result 往往还是 null，
 *   先判 null 会把「失败」显示成「未开始」。
 * 其次 running 优先于 result：上一次的结果还在，但这一次已经在跑了。
 */
export function assistStatusOf(
  running: boolean,
  result: AssistResult | null,
  error: string | null,
): AssistStatus {
  if (error !== null && error.trim() !== '') return 'error';
  if (running) return 'running';
  if (result !== null) return 'done';
  return 'idle';
}

/**
 * 原文太长时面板顶部只显示前 n 个字符（默认 200），末尾加省略号。
 * ★ 按码点切（[...text]）：中文与 emoji 不能被切出半个代理对，
 *   否则会显示成「?」或方块。
 */
export function truncateSource(text: string, n: number = 200): string {
  const chars = [...text];
  if (chars.length <= n) return text;
  return chars.slice(0, n).join('') + '…';
}
