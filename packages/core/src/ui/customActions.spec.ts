import { describe, expect, it } from 'vitest';
import type { CustomAction } from '../types';
import {
  CUSTOM_ACTIONS_MAX,
  CUSTOM_NAME_MAX_CODEPOINTS,
  CUSTOM_PROMPT_MAX_CODEPOINTS,
  customActionsRemaining,
  customPromptSummary,
  validateCustomAction,
} from './customActions';

describe('validateCustomAction（v1.2 D1）', () => {
  it('★ 合法输入通过，并给出 trim 后的规范值', () => {
    expect(validateCustomAction({ name: ' 周报 ', prompt: ' 把正文整理成周报 ' })).toEqual({
      ok: true,
      name: '周报',
      prompt: '把正文整理成周报',
    });
  });

  it('★ name / prompt 空白（或整个没传）都被拒，错误文案指明是哪个字段', () => {
    expect(validateCustomAction({ name: '   ', prompt: 'p' })).toEqual({ ok: false, error: '动作名称不能为空' });
    expect(validateCustomAction({ name: '名', prompt: '' })).toEqual({ ok: false, error: '提示词不能为空' });
    expect(validateCustomAction({ name: '名', prompt: '   ' })).toEqual({ ok: false, error: '提示词不能为空' });
    expect(validateCustomAction(undefined).ok).toBe(false);
    expect(validateCustomAction({}).ok).toBe(false);
  });

  it('name 超 12 个字被拒，正好 12 放行（按码点数，emoji 算一个字）', () => {
    expect(validateCustomAction({ name: '好'.repeat(CUSTOM_NAME_MAX_CODEPOINTS + 1), prompt: 'p' }).ok).toBe(false);
    const ok = validateCustomAction({ name: '好'.repeat(CUSTOM_NAME_MAX_CODEPOINTS), prompt: 'p' });
    expect(ok.ok).toBe(true);
    const emoji = validateCustomAction({ name: '😀'.repeat(CUSTOM_NAME_MAX_CODEPOINTS), prompt: 'p' });
    expect(emoji.ok).toBe(true);
  });

  it('prompt 超 2000 码点被拒，正好 2000 放行', () => {
    expect(validateCustomAction({ name: '名', prompt: '好'.repeat(CUSTOM_PROMPT_MAX_CODEPOINTS + 1) }).ok).toBe(false);
    expect(validateCustomAction({ name: '名', prompt: '好'.repeat(CUSTOM_PROMPT_MAX_CODEPOINTS) }).ok).toBe(true);
  });
});

describe('customActionsRemaining（v1.2 D1）', () => {
  it('上限 12：剩多少给多少，满了给 0，没传列表按空算', () => {
    expect(CUSTOM_ACTIONS_MAX).toBe(12);
    expect(customActionsRemaining(undefined)).toBe(12);
    const list: CustomAction[] = Array.from({ length: CUSTOM_ACTIONS_MAX }, (_, i) => ({
      id: String(i),
      name: '名' + i,
      prompt: 'p',
    }));
    expect(customActionsRemaining(list)).toBe(0);
    expect(customActionsRemaining(list.slice(0, 11))).toBe(1);
  });
});

describe('customPromptSummary（v1.2 D1）', () => {
  it('换行与连续空白折成单个空格', () => {
    expect(customPromptSummary('第一行\n\n第二行\t第三行')).toBe('第一行 第二行 第三行');
    expect(customPromptSummary('  两端空白  ')).toBe('两端空白');
  });

  it('超长按码点截断加省略号，emoji 不切半个', () => {
    expect(customPromptSummary('好'.repeat(45), 40)).toBe('好'.repeat(40) + '…');
    expect(customPromptSummary('好'.repeat(40), 40)).toBe('好'.repeat(40));
    const summary = customPromptSummary('😀'.repeat(45), 40);
    expect([...summary]).toHaveLength(41);
    expect(summary.endsWith('…')).toBe(true);
  });
});
