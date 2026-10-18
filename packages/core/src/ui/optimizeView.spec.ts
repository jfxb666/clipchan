import { beforeEach, describe, expect, it } from 'vitest';
import {
  COPIED_TOAST,
  OPTIMIZE_MODES,
  STOPPED_TOAST,
  beginStream,
  clearDraft,
  copyFailedToast,
  copiedToast,
  degradedHint,
  endStream,
  isValidRequestId,
  mergeDelta,
  newRequestId,
  saveDraft,
  stoppedToast,
  takeDraft,
} from './optimizeView';
import type { OptimizeDraft } from './optimizeView';

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

describe('newRequestId', () => {
  it('优先使用 crypto.randomUUID()', () => {
    expect(newRequestId({ randomUUID: () => 'a1b2c3-uuid' })).toBe('a1b2c3-uuid');
  });

  it('没有 crypto 时退回时间戳 + 随机串', () => {
    const id = newRequestId(null);
    expect(id.startsWith('req-')).toBe(true);
    expect(id.length).toBeGreaterThan('req-'.length);
  });

  it('randomUUID 抛错或返回空串时仍要给出可用 id', () => {
    const boom = newRequestId({
      randomUUID: () => {
        throw new Error('boom');
      },
    });
    expect(boom.startsWith('req-')).toBe(true);
    expect(newRequestId({ randomUUID: () => '' }).startsWith('req-')).toBe(true);
  });

  it('连续生成的 id 不重复且不含空白字符', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = newRequestId(null);
      expect(id).not.toMatch(/\s/);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });
});

describe('beginStream', () => {
  it('新一轮优化清空上一次的预览文本', () => {
    expect(beginStream('req-1')).toEqual({ requestId: 'req-1', text: '' });
  });
});

describe('mergeDelta', () => {
  it('同一请求的增量按到达顺序追加', () => {
    const first = mergeDelta('', { requestId: 'req-1', text: '你好' }, 'req-1');
    const second = mergeDelta(first, { requestId: 'req-1', text: '，世界' }, 'req-1');
    expect(second).toBe('你好，世界');
  });

  it('过期请求的增量被丢弃，预览文本一动不动', () => {
    expect(mergeDelta('当前请求的内容', { requestId: 'req-old', text: '旧数据' }, 'req-new')).toBe(
      '当前请求的内容',
    );
  });

  it('没有在途请求时任何增量都不写入', () => {
    expect(mergeDelta('已结束的结果', { requestId: 'req-1', text: '追加' }, null)).toBe('已结束的结果');
  });

  it('请求收尾后（endStream）迟到的增量不会再追加到可编辑的最终文本上', () => {
    const active = endStream();
    expect(active).toBeNull();
    expect(mergeDelta('最终结果', { requestId: 'req-1', text: '迟到的尾巴' }, active)).toBe('最终结果');
  });

  it('增量本身形状不对（空 requestId）时丢弃，不把脏数据写进预览', () => {
    expect(mergeDelta('已有内容', { requestId: '', text: '脏数据' }, 'req-1')).toBe('已有内容');
  });
});

describe('isValidRequestId', () => {
  it('非空且不含空白的字符串是合法 requestId', () => {
    expect(isValidRequestId('a1b2c3-uuid')).toBe(true);
    expect(isValidRequestId('req-mfx1-1-abc')).toBe(true);
  });

  it('空串、含空白、非字符串一律判为不合法', () => {
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('req 1')).toBe(false);
    expect(isValidRequestId('req\n1')).toBe(false);
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId(42)).toBe(false);
  });

  it('newRequestId 生成的 id 全部通过形状校验', () => {
    expect(isValidRequestId(newRequestId(null))).toBe(true);
    expect(isValidRequestId(newRequestId({ randomUUID: () => 'uuid-ok' }))).toBe(true);
  });
});

describe('复制结果提示', () => {
  it('成功文案固定为「已复制到剪贴板」，色调为 ok', () => {
    expect(COPIED_TOAST).toBe('已复制到剪贴板');
    expect(copiedToast()).toEqual({ text: COPIED_TOAST, tone: 'ok' });
  });

  it('失败文案带中文前缀并附上原因', () => {
    const toast = copyFailedToast(new Error('写剪贴板失败'));
    expect(toast.tone).toBe('error');
    expect(toast.text).toContain('复制失败，请重试');
    expect(toast.text).toContain('写剪贴板失败');
  });

  it('抛出的不是 Error 时也要给出中文提示，不把 undefined 摊给用户', () => {
    const toast = copyFailedToast(undefined);
    expect(toast.tone).toBe('error');
    expect(toast.text).toContain('复制失败，请重试');
    expect(toast.text).not.toContain('undefined');
  });
});

function draftOf(overrides: Partial<OptimizeDraft> = {}): OptimizeDraft {
  return {
    source: '原始提示词',
    sceneId: 'scene-1',
    mode: 'user',
    providerId: 'provider-1',
    input: '改过的原文',
    output: '优化后的结果',
    notes: ['提示一'],
    ...overrides,
  };
}

describe('草稿缓存', () => {
  beforeEach(() => {
    clearDraft();
  });

  it('saveDraft 与 takeDraft 往返一致', () => {
    const draft = draftOf();
    saveDraft(draft);
    expect(takeDraft()).toEqual(draft);
  });

  it('takeDraft 取过一次后就变 null', () => {
    saveDraft(draftOf());
    expect(takeDraft()).not.toBeNull();
    expect(takeDraft()).toBeNull();
  });

  it('clearDraft 之后取不到草稿', () => {
    saveDraft(draftOf());
    clearDraft();
    expect(takeDraft()).toBeNull();
  });

  it('没有存过草稿时 takeDraft 为 null', () => {
    expect(takeDraft()).toBeNull();
  });

  it('脏入参被忽略：不抛错，也不会污染已有草稿', () => {
    const good = draftOf();
    saveDraft(good);
    const dirty: unknown[] = [
      null,
      undefined,
      42,
      'draft',
      [],
      {},
      { ...good, mode: 'other' },
      { ...good, notes: 'not-an-array' },
      { ...good, notes: [1, 2] },
      { ...good, input: 1 },
      { ...good, source: null },
      { ...good, sceneId: undefined },
      { ...good, providerId: 5 },
      { ...good, output: {} },
    ];
    for (const value of dirty) {
      expect(() => saveDraft(value as OptimizeDraft)).not.toThrow();
    }
    expect(takeDraft()).toEqual(good);
  });

  it('再次 saveDraft 覆盖旧值', () => {
    saveDraft(draftOf());
    const next = draftOf({ sceneId: 'scene-2', mode: 'system', input: '第二次输入', output: '', notes: [] });
    saveDraft(next);
    expect(takeDraft()).toEqual(next);
  });

  it('取出的草稿是副本：改它不会影响缓存里的下一次取值', () => {
    const draft = draftOf({ notes: ['原提示'] });
    saveDraft(draft);
    const first = takeDraft();
    expect(first).not.toBeNull();
    first?.notes.push('外部追加');
    expect(draft.notes).toEqual(['原提示']);
    expect(takeDraft()).toBeNull();
  });
});

describe('停止提示', () => {
  it('文案固定为「已停止」，色调为 ok', () => {
    expect(STOPPED_TOAST).toBe('已停止');
    expect(stoppedToast()).toEqual({ text: STOPPED_TOAST, tone: 'ok' });
  });
});

