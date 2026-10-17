/**
 * 优化面板的纯函数与常量（计划 Task 7 Step 2）。
 * 仓库无 jsdom / testing-library（§2 约束），组件不可测，
 * 因此面板里所有可测逻辑都放进这个不依赖 React 的模块。
 */

export interface OptimizeMode {
  key: 'user' | 'system';
  label: string;
}

/** 两种优化目标：改写用户的提示词，或产出一份 system 提示词。 */
export const OPTIMIZE_MODES: OptimizeMode[] = [
  { key: 'user', label: '用户提示词' },
  { key: 'system', label: '系统提示词' },
];

/**
 * 模型没按约定格式返回时，引擎会把全文直接采用并置 degraded。
 * 这里给出给用户看的中文提示；正常解析时为 null（不显示黄条）。
 */
export function degradedHint(degraded: boolean): string | null {
  return degraded ? '模型未按格式输出，已直接采用全文' : null;
}
