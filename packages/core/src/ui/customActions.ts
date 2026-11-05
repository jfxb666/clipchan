import type { CustomAction } from '../types';

/**
 * 自定义 AI 动作（v1.2 D1）设置表单的纯逻辑。
 * 与 aiProviderForm.ts / excludeApps.ts 同一处理：组件不可测（没有 jsdom），
 * 校验与文案都放进这个不依赖 React 的模块。
 *
 * ★ 上限三常量与主进程 sanitizeCustomActions、ai 包 CUSTOM_PROMPT_MAX_CODEPOINTS
 *   同一口径——主进程是最后一道闸，这里是让用户在敲字的当下就看到错误，两处别各改各的。
 */

export const CUSTOM_ACTIONS_MAX = 12;
export const CUSTOM_NAME_MAX_CODEPOINTS = 12;
export const CUSTOM_PROMPT_MAX_CODEPOINTS = 2000;

const codepointLength = (s: string): number => [...s].length;

/** 添加/编辑表单的两个输入值。 */
export interface CustomActionFormValue {
  name: string;
  prompt: string;
}

/** 校验结果：ok 时给出 trim 后的规范值（调用方直接拿去保存），失败给一句中文错误。 */
export type CustomActionValidation =
  | { ok: true; name: string; prompt: string }
  | { ok: false; error: string };

/**
 * 校验一条自定义动作。规则与主进程 saveCustomAction 一致：
 * name / prompt trim 后非空，name ≤12 字、prompt ≤2000 字符（按码点数）。
 */
export function validateCustomAction(input: Partial<CustomActionFormValue> | undefined): CustomActionValidation {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (name === '') return { ok: false, error: '动作名称不能为空' };
  if (codepointLength(name) > CUSTOM_NAME_MAX_CODEPOINTS) return { ok: false, error: '动作名称不能超过 12 个字' };
  if (prompt === '') return { ok: false, error: '提示词不能为空' };
  if (codepointLength(prompt) > CUSTOM_PROMPT_MAX_CODEPOINTS) return { ok: false, error: '提示词不能超过 2000 个字符' };
  return { ok: true, name, prompt };
}

/** 列表还能加几条；0 = 已满（「添加」按钮置灰并改文案）。 */
export function customActionsRemaining(list: readonly CustomAction[] | undefined): number {
  return Math.max(0, CUSTOM_ACTIONS_MAX - (list?.length ?? 0));
}

/**
 * 列表行里提示词的一行摘要：空白（含换行）折成单个空格，超 max 码点截断加省略号。
 * ★ 按码点切（[...s]）：emoji 不会切出半个代理对（与 truncateSource 同一考虑）。
 */
export function customPromptSummary(prompt: string, max = 40): string {
  const oneLine = prompt.replace(/\s+/gu, ' ').trim();
  const chars = [...oneLine];
  if (chars.length <= max) return oneLine;
  return chars.slice(0, max).join('') + '…';
}
