import { describe, expect, it } from 'vitest';
import { OPTIMIZE_MODES, degradedHint } from './optimizeView';

describe('degradedHint', () => {
  it('模型没按格式输出时给出黄色提示文案', () => {
    const hint = degradedHint(true);
    expect(hint).not.toBeNull();
    expect(hint).toContain('未按格式输出');
  });

  it('正常解析时没有提示', () => {
    expect(degradedHint(false)).toBeNull();
  });
});

describe('OPTIMIZE_MODES', () => {
  it('两条模式的 key 顺序为 user、system', () => {
    expect(OPTIMIZE_MODES.map((m) => m.key)).toEqual(['user', 'system']);
  });

  it('两条模式的 label 互不相同且非空', () => {
    const labels = OPTIMIZE_MODES.map((m) => m.label);
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
    expect(labels[0]).not.toBe(labels[1]);
  });
});
