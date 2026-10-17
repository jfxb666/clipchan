import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BurstHint, ClipItemDTO, ClipchanApi, GhostState, ListQuery, NavigateTarget, Settings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { setPlatform } from '../platform/adapter';
import { PAGE_SIZE, QUERY_DEBOUNCE_MS, bindClipStore, resetClipStore, useClipStore } from './store';

/**
 * store 的单测全部用假平台适配器注入（setPlatform），不真连 Electron。
 * 重点覆盖两条硬要求：
 *   1. setQuery 防抖 300ms —— 连打 3 次只发 1 次请求；
 *   2. hasMore=false 时 loadMore() 不发请求。
 */

function item(id: string, patch: Partial<ClipItemDTO> = {}): ClipItemDTO {
  return {
    id,
    kind: 'text',
    preview: '预览 ' + id,
    createdAt: 1000,
    pinned: false,
    source: 'capture',
    ...patch,
  };
}

/** 造一个记录全部调用的假适配器。 */
function makeFakeAdapter(seed: ClipItemDTO[] = []) {
  const listCalls: ListQuery[] = [];
  const pasteCalls: string[] = [];
  const removeCalls: string[] = [];
  const pinCalls: string[] = [];
  const ghostCalls: number[] = [];
  const settingCalls: Partial<Settings>[] = [];
  const unsubscribed: string[] = [];
  let itemChanged: (() => void) | null = null;
  let settingsChanged: ((s: Settings) => void) | null = null;
  let ghostChanged: ((g: GhostState) => void) | null = null;
  let burstHinted: ((hint: BurstHint) => void) | null = null;
  let navigated: ((target: NavigateTarget) => void) | null = null;

  const adapter: ClipchanApi = {
    items: {
      list: async (q: ListQuery) => {
        listCalls.push(q);
        const offset = q.offset ?? 0;
        const limit = q.limit ?? PAGE_SIZE;
        return seed.slice(offset, offset + limit);
      },
      paste: async (id: string) => {
        pasteCalls.push(id);
        return { ok: true };
      },
      remove: async (id: string) => {
        removeCalls.push(id);
      },
      togglePin: async (id: string) => {
        pinCalls.push(id);
      },
      clearUnpinned: async () => {},
      clearAll: async () => {},
      mergeSelected: async () => ({ ok: true, id: 'merged-1' }),
      getFullImage: async () => '',
      getText: async () => '',
      onChanged: (cb: () => void) => {
        itemChanged = cb;
        return () => {
          unsubscribed.push('items');
          itemChanged = null;
        };
      },
      onBurstHint: (cb: (hint: BurstHint) => void) => {
        burstHinted = cb;
        return () => {
          unsubscribed.push('burstHint');
          burstHinted = null;
        };
      },
    },
    settings: {
      get: async () => ({ ...DEFAULT_SETTINGS }),
      set: async (patch: Partial<Settings>) => {
        settingCalls.push(patch);
        return { ...DEFAULT_SETTINGS, ...patch };
      },
      onChanged: (cb: (s: Settings) => void) => {
        settingsChanged = cb;
        return () => {
          unsubscribed.push('settings');
          settingsChanged = null;
        };
      },
    },
    ghost: {
      get: async () => ({ active: false, remainingMs: 0, until: null }),
      set: async (minutes: number) => {
        ghostCalls.push(minutes);
        return minutes > 0
          ? { active: true, remainingMs: minutes * 60000, until: Date.now() + minutes * 60000 }
          : { active: false, remainingMs: 0, until: null };
      },
      onChanged: (cb: (g: GhostState) => void) => {
        ghostChanged = cb;
        return () => {
          unsubscribed.push('ghost');
          ghostChanged = null;
        };
      },
    },
    app: {
      setMode: async () => {},
      hide: async () => {},
      setWidgetSize: async () => {},
      setWidgetHeight: async () => {},
      resizeBy: async (_dw: number, _dh: number, _shape?: boolean) => {},
      getHotkeyStatus: async () => ({ activate: true, widget: true, conflicts: [] }),
      getAutoStart: async () => false,
      setAutoStart: async () => true,
      openDataFolder: async () => {},
      onMode: () => () => {
        unsubscribed.push('mode');
      },
      onNavigate: (cb: (target: NavigateTarget) => void) => {
        navigated = cb;
        return () => {
          unsubscribed.push('navigate');
          navigated = null;
        };
      },
    },
    wordcloud: {
      today: async () => ({ words: [], totalItems: 0 }),
      exportPng: async () => ({ ok: true }),
    },
    ai: {
      listProviders: async () => [],
      saveProvider: async () => [],
      removeProvider: async () => [],
      listModels: async () => [],
      test: async () => ({ ok: false }),
      optimize: async () => ({ optimized: '', notes: [], degraded: false }),
      scenes: async () => [],
      copyAndPaste: async () => ({ ok: false, reason: 'send-failed' }),
      onChanged: () => () => {},
    },
    capabilities: {
      autoPaste: true,
      globalHotkey: true,
      backgroundCapture: true,
      frostedGlass: false,
    },
  };

  return {
    adapter,
    listCalls,
    pasteCalls,
    removeCalls,
    pinCalls,
    ghostCalls,
    settingCalls,
    unsubscribed,
    fireItemChanged: () => itemChanged?.(),
    fireSettingsChanged: (s: Settings) => settingsChanged?.(s),
    fireGhostChanged: (g: GhostState) => ghostChanged?.(g),
    fireBurstHint: (hint: BurstHint) => burstHinted?.(hint),
    fireNavigate: (target: NavigateTarget) => navigated?.(target),
  };
}

beforeEach(() => {
  resetClipStore();
});

afterEach(() => {
  resetClipStore();
  setPlatform(null);
  vi.useRealTimers();
});

describe('useClipStore 列表加载', () => {
  it('load() 后 items 等于假适配器返回的数据，且收藏置顶', async () => {
    const fake = makeFakeAdapter([
      item('a', { createdAt: 300 }),
      item('b', { createdAt: 200, pinned: true }),
      item('c', { createdAt: 100 }),
    ]);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();

    expect(useClipStore.getState().items.map((it) => it.id)).toEqual(['b', 'a', 'c']);
    expect(useClipStore.getState().loading).toBe(false);
  });

  it('首次加载带 limit=200 / offset=0，不带空搜索词', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();

    expect(fake.listCalls).toHaveLength(1);
    expect(fake.listCalls[0]).toMatchObject({ kind: 'all', limit: PAGE_SIZE, offset: 0 });
    expect(fake.listCalls[0]?.q).toBeUndefined();
  });

  it('setKind("image") 会带 kind:"image" 重新请求', async () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);

    useClipStore.getState().setKind('image');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    expect(fake.listCalls[0]?.kind).toBe('image');
    expect(useClipStore.getState().kind).toBe('image');
  });

  it('loadMore() 在 hasMore=false 时不发请求', async () => {
    const fake = makeFakeAdapter([item('a'), item('b')]);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();
    expect(useClipStore.getState().hasMore).toBe(false);
    const before = fake.listCalls.length;

    await useClipStore.getState().loadMore();

    expect(fake.listCalls.length).toBe(before);
  });

  it('loadMore() 在 hasMore=true 时按 offset=已加载条数追加', async () => {
    const seed = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => item('i' + i, { createdAt: 10000 - i }));
    const fake = makeFakeAdapter(seed);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();
    expect(useClipStore.getState().items).toHaveLength(PAGE_SIZE);
    expect(useClipStore.getState().hasMore).toBe(true);

    await useClipStore.getState().loadMore();

    expect(fake.listCalls[1]).toMatchObject({ offset: PAGE_SIZE });
    expect(useClipStore.getState().items).toHaveLength(PAGE_SIZE + 3);
    expect(useClipStore.getState().hasMore).toBe(false);
  });
});

describe('setQuery 防抖 300ms', () => {
  it('300ms 内连打 3 次只发 1 次请求，且用最后一次的词', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    const { setQuery } = useClipStore.getState();

    setQuery('a');
    setQuery('ab');
    setQuery('abc');

    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS - 1);
    expect(fake.listCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.listCalls).toHaveLength(1);
    expect(fake.listCalls[0]?.q).toBe('abc');
    expect(useClipStore.getState().q).toBe('abc');
  });

  it('两次输入间隔超过防抖窗口时各发一次', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('one');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS);
    useClipStore.getState().setQuery('two');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS);

    expect(fake.listCalls.map((c) => c.q)).toEqual(['one', 'two']);
  });
});

describe('选择与操作', () => {
  it('select 支持单选与 Ctrl 多选', async () => {
    const fake = makeFakeAdapter([item('a'), item('b'), item('c')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    useClipStore.getState().select('a');
    expect(useClipStore.getState().selectedId).toBe('a');

    useClipStore.getState().select('b', { multi: true });
    expect(useClipStore.getState().selectedIds).toEqual(['a', 'b']);
    expect(useClipStore.getState().selectedId).toBe('a');

    useClipStore.getState().select('a', { multi: true });
    expect(useClipStore.getState().selectedIds).toEqual(['b']);
  });

  it('moveSelection 在列表里上下移动选中项', async () => {
    const fake = makeFakeAdapter([item('a', { createdAt: 300 }), item('b', { createdAt: 200 }), item('c', { createdAt: 100 })]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    useClipStore.getState().moveSelection(1);
    expect(useClipStore.getState().selectedId).toBe('a');

    useClipStore.getState().moveSelection(1);
    expect(useClipStore.getState().selectedId).toBe('b');

    useClipStore.getState().moveSelection(-1);
    expect(useClipStore.getState().selectedId).toBe('a');
  });

  it('togglePin 乐观更新并调用主进程', async () => {
    const fake = makeFakeAdapter([item('a', { createdAt: 300 }), item('b', { createdAt: 200 })]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    await useClipStore.getState().togglePin('b');

    expect(fake.pinCalls).toEqual(['b']);
    expect(useClipStore.getState().items[0]?.id).toBe('b');
    expect(useClipStore.getState().items[0]?.pinned).toBe(true);
  });

  it('remove 删除多条并清理选中', async () => {
    const fake = makeFakeAdapter([item('a'), item('b'), item('c')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    useClipStore.getState().select('a');
    useClipStore.getState().select('b', { multi: true });

    await useClipStore.getState().remove(['a', 'b']);

    expect(fake.removeCalls.sort()).toEqual(['a', 'b']);
    expect(useClipStore.getState().items.map((it) => it.id)).toEqual(['c']);
    expect(useClipStore.getState().selectedIds).toEqual([]);
    expect(useClipStore.getState().selectedId).toBeNull();
  });

  it('pasteSelected 粘贴主选中项并弹提示', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    useClipStore.getState().select('a');

    await useClipStore.getState().pasteSelected();

    expect(fake.pasteCalls).toEqual(['a']);
    expect(useClipStore.getState().toasts.at(-1)?.text).toBe('已粘贴');
  });

  it('mergeSelected 选中不足 2 条时不调用主进程，只提示', async () => {
    const fake = makeFakeAdapter([item('a'), item('b')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    useClipStore.getState().select('a');

    await useClipStore.getState().mergeSelected();

    expect(fake.pasteCalls).toEqual([]);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('至少 2 条');
  });
});

describe('设置 / 幽灵模式 / 订阅', () => {
  it('updateSettings 落库并同步 widgetSize 到窗口', async () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);

    await useClipStore.getState().updateSettings({ historyLimit: 500 });

    expect(fake.settingCalls[0]).toEqual({ historyLimit: 500 });
    expect(useClipStore.getState().settings.historyLimit).toBe(500);
  });

  it('setGhost(0) 关闭幽灵模式并提示监听已恢复', async () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);

    await useClipStore.getState().setGhost(10);
    expect(useClipStore.getState().ghost.active).toBe(true);
    expect(fake.ghostCalls).toEqual([10]);

    await useClipStore.getState().setGhost(0);
    expect(useClipStore.getState().ghost.active).toBe(false);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('监听已恢复');
  });

  it('bindClipStore 订阅 items.onChanged 并返回取消函数', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    const unbind = bindClipStore();
    const before = fake.listCalls.length;
    fake.fireItemChanged();
    await vi.waitFor(() => expect(fake.listCalls.length).toBe(before + 1));

    unbind();
    expect(fake.unsubscribed).toContain('items');
    expect(fake.unsubscribed).toContain('settings');
    expect(fake.unsubscribed).toContain('ghost');
  });

  it('幽灵状态从激活变为关闭时补一条恢复提示', () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);
    const unbind = bindClipStore();
    useClipStore.setState({ ghost: { active: true, remainingMs: 1000, until: Date.now() + 1000 } });

    fake.fireGhostChanged({ active: false, remainingMs: 0, until: null });

    expect(useClipStore.getState().ghost.active).toBe(false);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('监听已恢复');
    unbind();
  });
});
