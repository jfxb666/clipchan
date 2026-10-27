import { describe, expect, it } from 'vitest';
import type { AssistRequest, AssistResult } from '../types';
import {
  ASSIST_ACTION_OPTIONS,
  ASSIST_LANG_OPTIONS,
  assistNeedsLang,
  assistStatusOf,
  defaultTargetLang,
  degradedHint,
  truncateSource,
  type AssistStatus,
} from './assistView';

const ALL_ACTIONS: AssistRequest['action'][] = ['translate', 'summarize', 'rewrite', 'explain', 'extract'];

describe('ASSIST_ACTION_OPTIONS', () => {
  it('顺序固定：翻译 / 总结 / 改写 / 解释 / 提取要点', () => {
    expect(ASSIST_ACTION_OPTIONS.map((option) => option.id)).toEqual([
      'translate',
      'summarize',
      'rewrite',
      'explain',
      'extract',
    ]);
  });

  it('按钮文字逐字对应', () => {
    expect(ASSIST_ACTION_OPTIONS.map((option) => option.name)).toEqual([
      '翻译',
      '总结',
      '改写',
      '解释',
      '提取要点',
    ]);
  });

  it('五个动作一个不多一个不少', () => {
    expect(ASSIST_ACTION_OPTIONS).toHaveLength(5);
  });

  it('每个动作都有一句非空的悬停解释', () => {
    for (const option of ASSIST_ACTION_OPTIONS) expect(option.hint.trim().length).toBeGreaterThan(0);
  });

  it('id 与 assistNeedsLang 的参数枚举完全一致（面板与请求不会对不上）', () => {
    expect(ASSIST_ACTION_OPTIONS.map((option) => option.id)).toEqual(ALL_ACTIONS);
  });
});

describe('ASSIST_LANG_OPTIONS', () => {
  it('三条：简体中文 / 英文 / 日文', () => {
    expect(ASSIST_LANG_OPTIONS.map((option) => option.name)).toEqual(['简体中文', '英文', '日文']);
  });

  it('id 分别是 zh-CN / en / ja', () => {
    expect(ASSIST_LANG_OPTIONS.map((option) => option.id)).toEqual(['zh-CN', 'en', 'ja']);
  });

  it('defaultTargetLang 的返回值都在语言列表里（不会选中一个不存在的项）', () => {
    const ids = ASSIST_LANG_OPTIONS.map((option) => option.id);
    for (const sample of ['你好', 'hello', '', '你好 hello']) {
      expect(ids).toContain(defaultTargetLang(sample));
    }
  });
});

describe('assistNeedsLang', () => {
  it('translate → true', () => {
    expect(assistNeedsLang('translate')).toBe(true);
  });

  it('summarize → false', () => {
    expect(assistNeedsLang('summarize')).toBe(false);
  });

  it('rewrite → false', () => {
    expect(assistNeedsLang('rewrite')).toBe(false);
  });

  it('explain → false', () => {
    expect(assistNeedsLang('explain')).toBe(false);
  });

  it('extract → false', () => {
    expect(assistNeedsLang('extract')).toBe(false);
  });

  it('五个动作里只有翻译需要语言', () => {
    expect(ALL_ACTIONS.filter((action) => assistNeedsLang(action))).toEqual(['translate']);
  });
});

describe('defaultTargetLang', () => {
  it('纯中文 → 译成英文 en', () => {
    expect(defaultTargetLang('今天天气不错，我们出去走走吧')).toBe('en');
  });

  it('纯英文 → 译成简体中文 zh-CN', () => {
    expect(defaultTargetLang('The quick brown fox jumps over the lazy dog')).toBe('zh-CN');
  });

  it('中英混排但中文更多 → en', () => {
    expect(defaultTargetLang('这个 API 返回的是 Promise 对象，需要 await 一下才能拿到结果')).toBe('en');
  });

  it('中英混排但英文更多 → zh-CN', () => {
    expect(defaultTargetLang('Hello world, 你好')).toBe('zh-CN');
  });

  it('空串 → zh-CN（没有线索时的默认值）', () => {
    expect(defaultTargetLang('')).toBe('zh-CN');
  });

  it('数字与标点不算任何一种语言 → zh-CN', () => {
    expect(defaultTargetLang('123 !!! --- ')).toBe('zh-CN');
  });
});

describe('degradedHint', () => {
  it('degraded=true → 给出原始回复的提示文案', () => {
    expect(degradedHint(true)).toBe('模型没按格式返回，下面是原始回复，可能需要自己摘一下');
  });

  it('degraded=false → 空串（不显示黄条）', () => {
    expect(degradedHint(false)).toBe('');
  });
});

describe('assistStatusOf', () => {
  const result: AssistResult = { text: '结果', degraded: false };

  it('什么都没发生 → idle', () => {
    expect(assistStatusOf(false, null, null)).toBe('idle');
  });

  it('在跑 → running', () => {
    expect(assistStatusOf(true, null, null)).toBe('running');
  });

  it('有结果且不在跑 → done', () => {
    expect(assistStatusOf(false, result, null)).toBe('done');
  });

  it('有错误 → error', () => {
    expect(assistStatusOf(false, null, '网络不通')).toBe('error');
  });

  it('error 优先于 result：失败时上一次的结果还留着也报 error', () => {
    expect(assistStatusOf(false, result, '网络不通')).toBe('error');
  });

  it('error 优先于 running', () => {
    expect(assistStatusOf(true, null, '网络不通')).toBe('error');
  });

  it('running 优先于 result：重跑时旧结果还挂着也显示在跑', () => {
    expect(assistStatusOf(true, result, null)).toBe('running');
  });

  it('空白错误串不算出错（先 trim 后判空）', () => {
    expect(assistStatusOf(false, result, '   ')).toBe('done');
    expect(assistStatusOf(false, null, '')).toBe('idle');
    expect(assistStatusOf(true, null, '  \n\t ')).toBe('running');
  });

  it('每个分支都落在 AssistStatus 的四个值里', () => {
    const all: AssistStatus[] = ['idle', 'running', 'done', 'error'];
    expect(all).toContain(assistStatusOf(false, null, null));
    expect(all).toContain(assistStatusOf(true, null, null));
    expect(all).toContain(assistStatusOf(false, result, null));
    expect(all).toContain(assistStatusOf(false, null, 'x'));
  });
});

describe('truncateSource', () => {
  it('短文本原样返回（不加省略号）', () => {
    expect(truncateSource('一段短短的原文')).toBe('一段短短的原文');
  });

  it('超长文本截断到 n 个字符并加省略号', () => {
    const long = 'a'.repeat(250);
    expect(truncateSource(long, 10)).toBe('aaaaaaaaaa…');
  });

  it('默认按 200 个字符截断', () => {
    const long = '中'.repeat(300);
    const out = truncateSource(long);
    expect([...out]).toHaveLength(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('刚好 n 个字符不截断', () => {
    const exact = 'b'.repeat(10);
    expect(truncateSource(exact, 10)).toBe(exact);
  });

  it('emoji 不会被切出半个代理对', () => {
    const emoji = '😀'.repeat(10);
    const out = truncateSource(emoji, 3);
    expect(out).toBe('😀😀😀…');
    expect([...out]).toHaveLength(4);
  });

  it('中文按码点切（不会切出乱码）', () => {
    expect(truncateSource('剪贴板酱很好用', 3)).toBe('剪贴板…');
  });

  it('空串原样返回空串', () => {
    expect(truncateSource('')).toBe('');
  });
});
