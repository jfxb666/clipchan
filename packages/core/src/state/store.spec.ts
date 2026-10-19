import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppToast,
  BurstHint,
  ClipItemDTO,
  ClipchanApi,
  GhostState,
  ListQuery,
  NavigateTarget,
  Settings,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { setPlatform } from '../platform/adapter';
import {
  CLEAR_CONFIRM_TTL_MS,
  PAGE_SIZE,
  QUERY_DEBOUNCE_MS,
  TOAST_TTL_MS,
  bindClipStore,
  resetClipStore,
  useClipStore,
} from './store';
import { UNDO_LABEL } from '../ui/toastText';
import { TRASH_PAGE_SIZE } from '../ui/trashViewLogic';

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
  const countCalls: ListQuery[] = [];
  const exportCalls: number[] = [];
  const importCalls: number[] = [];
  /** v0.3.0 回收站 / 撤销相关的调用记录。 */
  const restoreCalls: string[] = [];
  const purgeCalls: string[][] = [];
  const emptyTrashCalls: number[] = [];
  const trashListCalls: { limit?: number; offset?: number }[] = [];
  let trashSeed: ClipItemDTO[] = [];
  /** 让 restore 的返回值由用例决定：默认全部成功。 */
  let restoreResult: (id: string) => { ok: boolean; reason?: 'duplicate' | 'missing' } = () => ({ ok: true });
  /** 让 count 失败/成功由用例决定：null = 用 seed.length。 */
  let countResult: number | null = null;
  let countThrows = false;
  let exportResult: { ok: boolean; cancelled?: boolean; path?: string; reason?: string } = {
    ok: true,
    path: 'C:/tmp/export.zip',
  };
  let importResult: {
    ok: boolean;
    cancelled?: boolean;
    imported?: number;
    skippedDuplicate?: number;
    skippedInvalid?: number;
    missingImages?: number;
    reason?: string;
  } = { ok: true, imported: 0 };
  const unsubscribed: string[] = [];
  let itemChanged: (() => void) | null = null;
  let settingsChanged: ((s: Settings) => void) | null = null;
  let ghostChanged: ((g: GhostState) => void) | null = null;
  let burstHinted: ((hint: BurstHint) => void) | null = null;
  let navigated: ((target: NavigateTarget) => void) | null = null;
  /** 主进程推 toast 的回调（app:toast）。 */
  let toastPushed: ((t: AppToast) => void) | null = null;

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
      copy: async () => ({ ok: false, reason: 'no-target' }),
      getFullImage: async () => '',
      count: async (q: ListQuery) => {
        countCalls.push(q);
        if (countThrows) throw new Error('count 失败');
        return countResult === null ? seed.length : countResult;
      },
      exportAll: async () => {
        exportCalls.push(1);
        return exportResult;
      },
      importAll: async () => {
        importCalls.push(1);
        return importResult;
      },
      getText: async () => '',
      trashList: async (q: { limit?: number; offset?: number }) => {
        trashListCalls.push(q);
        const offset = q.offset ?? 0;
        const limit = q.limit ?? 200;
        return trashSeed.slice(offset, offset + limit);
      },
      trashCount: async () => trashSeed.length,
      restore: async (id: string) => {
        restoreCalls.push(id);
        return restoreResult(id);
      },
      purge: async (ids: string[]) => {
        purgeCalls.push(ids);
        return { removed: ids.length };
      },
      emptyTrash: async () => {
        emptyTrashCalls.push(1);
        const removed = trashSeed.length;
        trashSeed = [];
        return { removed };
      },
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
      onToast: (cb: (t: AppToast) => void) => {
        toastPushed = cb;
        return () => {
          unsubscribed.push('toast');
          toastPushed = null;
        };
      },
    },
    wordcloud: {
      today: async () => ({ words: [], totalItems: 0 }),
      exportPng: async () => ({ ok: true }),
    },
    clipboard: {
      writeText: async () => {},
    },
    ai: {
      listProviders: async () => [],
      saveProvider: async () => [],
      removeProvider: async () => [],
      listModels: async () => [],
      test: async () => ({ ok: false }),
      optimize: async () => ({ optimized: '', notes: [], degraded: false }),
      cancel: async () => {},
      scenes: async () => [],
      copyAndPaste: async () => ({ ok: false, reason: 'send-failed' }),
      onChanged: () => () => {},
      onOptimizeDelta: () => () => {},
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
    countCalls,
    exportCalls,
    importCalls,
    restoreCalls,
    purgeCalls,
    emptyTrashCalls,
    trashListCalls,
    unsubscribed,
    setTrashSeed: (items: ClipItemDTO[]) => {
      trashSeed = items;
    },
    setRestoreResult: (fn: (id: string) => { ok: boolean; reason?: 'duplicate' | 'missing' }) => {
      restoreResult = fn;
    },
    setCountResult: (n: number | null) => {
      countResult = n;
    },
    setCountThrows: (v: boolean) => {
      countThrows = v;
    },
    setExportResult: (v: { ok: boolean; cancelled?: boolean; path?: string; reason?: string }) => {
      exportResult = v;
    },
    setImportResult: (v: {
      ok: boolean;
      cancelled?: boolean;
      imported?: number;
      skippedDuplicate?: number;
      skippedInvalid?: number;
      missingImages?: number;
      reason?: string;
    }) => {
      importResult = v;
    },
    fireItemChanged: () => itemChanged?.(),
    fireSettingsChanged: (s: Settings) => settingsChanged?.(s),
    fireGhostChanged: (g: GhostState) => ghostChanged?.(g),
    fireBurstHint: (hint: BurstHint) => burstHinted?.(hint),
    fireNavigate: (target: NavigateTarget) => navigated?.(target),
    fireToast: (t: AppToast) => toastPushed?.(t),
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

describe('total 是真实总数（不是已加载条数）', () => {
  it('load() 用 items.count 的结果，而不是 list 回来的条数', async () => {
    const fake = makeFakeAdapter([item('a'), item('b')]);
    fake.setCountResult(417);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();

    expect(useClipStore.getState().total).toBe(417);
    expect(useClipStore.getState().items).toHaveLength(2);
  });

  it('count 与 list 用同一套条件（分类 + 搜索词）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();
    const listQuery = fake.listCalls.at(-1);
    const countQuery = fake.countCalls.at(-1);

    expect(countQuery?.kind).toBe(listQuery?.kind);
    expect(countQuery?.q).toBe(listQuery?.q);
    expect(countQuery?.limit).toBe(listQuery?.limit);
  });

  it('count 抛错时退回已加载条数，整页仍加载成功', async () => {
    const fake = makeFakeAdapter([item('a'), item('b'), item('c')]);
    fake.setCountThrows(true);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();

    expect(useClipStore.getState().items).toHaveLength(3);
    expect(useClipStore.getState().total).toBe(3);
    expect(useClipStore.getState().loading).toBe(false);
  });

  it('remove 之后 total 跟着减，不留在旧数字', async () => {
    const fake = makeFakeAdapter([item('a'), item('b'), item('c')]);
    fake.setCountResult(3);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    expect(useClipStore.getState().total).toBe(3);

    await useClipStore.getState().remove(['a', 'b']);

    expect(useClipStore.getState().total).toBe(1);
  });

  it('remove 不会把 total 减成负数', async () => {
    const fake = makeFakeAdapter([item('a')]);
    fake.setCountResult(0);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    await useClipStore.getState().remove(['a']);

    expect(useClipStore.getState().total).toBe(0);
  });
});

describe('pressClearUnpinned 二次确认', () => {
  it('第一次按只提示，不调用主进程', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    let cleared = 0;
    const original = fake.adapter.items.clearUnpinned;
    fake.adapter.items.clearUnpinned = async () => {
      cleared += 1;
      await original();
    };

    useClipStore.getState().pressClearUnpinned();

    expect(cleared).toBe(0);
    expect(useClipStore.getState().confirmClear).toBe(true);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('再按一次');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('warn');
  });

  it('第二次按真正清空并复位 confirmClear', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    let cleared = 0;
    fake.adapter.items.clearUnpinned = async () => {
      cleared += 1;
    };

    useClipStore.getState().pressClearUnpinned();
    useClipStore.getState().pressClearUnpinned();
    await vi.waitFor(() => expect(cleared).toBe(1));

    expect(useClipStore.getState().confirmClear).toBe(false);
  });

  it('超过确认窗口后回到未确认状态', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().pressClearUnpinned();
    expect(useClipStore.getState().confirmClear).toBe(true);

    vi.advanceTimersByTime(CLEAR_CONFIRM_TTL_MS);
    expect(useClipStore.getState().confirmClear).toBe(false);
  });

  it('确认窗口过期后再按一次仍然只是提示（不误清空）', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    let cleared = 0;
    fake.adapter.items.clearUnpinned = async () => {
      cleared += 1;
    };

    useClipStore.getState().pressClearUnpinned();
    vi.advanceTimersByTime(CLEAR_CONFIRM_TTL_MS + 1);
    useClipStore.getState().pressClearUnpinned();

    expect(cleared).toBe(0);
    expect(useClipStore.getState().confirmClear).toBe(true);
  });
});

describe('exportAll', () => {
  it('成功时提示导出路径', async () => {
    const fake = makeFakeAdapter([]);
    fake.setExportResult({ ok: true, path: 'C:/data/export-20260101.zip' });
    setPlatform(fake.adapter);

    await useClipStore.getState().exportAll();

    expect(fake.exportCalls).toHaveLength(1);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('C:/data/export-20260101.zip');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('ok');
  });

  it('★ 用户点「取消」时静默返回：不弹「导出失败」', async () => {
    const fake = makeFakeAdapter([]);
    // 保存对话框点取消：既没落盘也没出错，cancelled:true 且没有 reason
    fake.setExportResult({ ok: false, cancelled: true });
    setPlatform(fake.adapter);

    await useClipStore.getState().exportAll();

    expect(fake.exportCalls).toHaveLength(1);
    expect(useClipStore.getState().toasts).toHaveLength(0);
  });

  it('失败时如实提示，不假装成功', async () => {
    const fake = makeFakeAdapter([]);
    fake.setExportResult({ ok: false, reason: '磁盘已满' });
    setPlatform(fake.adapter);

    await useClipStore.getState().exportAll();

    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('导出失败');
    // 有 reason 就把真原因带出来，不要笼统的「导出失败」
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('磁盘已满');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('warn');
  });

  it('主进程抛错时把错误文案带出来', async () => {
    const fake = makeFakeAdapter([]);
    fake.adapter.items.exportAll = async () => {
      throw new Error('磁盘只读');
    };
    setPlatform(fake.adapter);

    await useClipStore.getState().exportAll();

    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('磁盘只读');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('error');
  });
});

describe('importAll（v0.3.0 zip 备份包）', () => {
  it('★ 成功后只刷新列表，不再重复 toast（主进程已发过汇总）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    fake.setImportResult({ ok: true, imported: 3, skippedDuplicate: 1, skippedInvalid: 0, missingImages: 0 });
    setPlatform(fake.adapter);

    await useClipStore.getState().importAll();

    expect(fake.importCalls).toHaveLength(1);
    // 主进程 main.ts 已经 broadcast.toast(importSummaryText(...))，这里再弹就是两条
    expect(useClipStore.getState().toasts).toHaveLength(0);
    // 但列表必须重新拉：否则用户看不到新导进来的条目
    expect(fake.listCalls.length).toBeGreaterThan(0);
  });

  it('★ 取消时静默：不弹 toast，也不刷新列表', async () => {
    const fake = makeFakeAdapter([]);
    fake.setImportResult({ ok: false, cancelled: true });
    setPlatform(fake.adapter);

    await useClipStore.getState().importAll();

    expect(useClipStore.getState().toasts).toHaveLength(0);
    expect(fake.listCalls).toHaveLength(0);
  });

  it('失败时把 reason 如实带出来', async () => {
    const fake = makeFakeAdapter([]);
    fake.setImportResult({ ok: false, reason: '这不是 Clipchan 的备份包' });
    setPlatform(fake.adapter);

    await useClipStore.getState().importAll();

    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('导入失败');
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('这不是 Clipchan 的备份包');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('warn');
  });

  it('主进程抛错时把错误文案带出来（error 档）', async () => {
    const fake = makeFakeAdapter([]);
    fake.adapter.items.importAll = async () => {
      throw new Error('zip 已损坏');
    };
    setPlatform(fake.adapter);

    await useClipStore.getState().importAll();

    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('zip 已损坏');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('error');
  });
});

describe('主进程推来的 toast（app:toast）', () => {
  it('pushToast 把消息送进 toasts 队列', () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);

    useClipStore.getState().pushToast('同内容已在列表中，无需恢复', 'ok');

    const last = useClipStore.getState().toasts.at(-1);
    expect(last?.text).toBe('同内容已在列表中，无需恢复');
    expect(last?.tone).toBe('ok');
  });

  it('绑定 store 后 fireToast 能落到 toasts（订阅链路完整）', () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);
    const unbind = bindClipStore();

    fake.fireToast({ message: '已清空回收站', kind: 'warn' });

    expect(useClipStore.getState().toasts.at(-1)?.text).toBe('已清空回收站');
    unbind();
  });

  it('★ 取消订阅后不再接收（卸载不叠加监听）', () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);
    const unbind = bindClipStore();
    unbind();

    expect(fake.unsubscribed).toContain('toast');
    fake.fireToast({ message: '不该出现', kind: 'info' });
    expect(useClipStore.getState().toasts).toHaveLength(0);
  });
});

describe('删除后的撤销窗口', () => {
  it('remove 成功后记下被删的 id，并弹出带「撤销」按钮的提示', async () => {
    const fake = makeFakeAdapter([item('a'), item('b'), item('c')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    await useClipStore.getState().remove('b');

    expect(useClipStore.getState().lastDeletedIds).toEqual(['b']);
    const last = useClipStore.getState().toasts.at(-1);
    expect(last?.text).toBe('已删除 1 条（进回收站）');
    expect(last?.action?.label).toBe(UNDO_LABEL);
  });

  it('提示条上的「撤销」按钮真的接到 undoRemove（action.onClick 即撤销入口）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    await useClipStore.getState().remove('a');

    const action = useClipStore.getState().toasts.at(-1)?.action;
    expect(action).toBeDefined();
    action?.onClick();
    await vi.waitFor(() => expect(fake.restoreCalls).toEqual(['a']));
  });

  it('removeSelected 把整批 id 都记下来', async () => {
    const fake = makeFakeAdapter([item('a'), item('b'), item('c')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    useClipStore.getState().select('a');
    useClipStore.getState().select('b', { multi: true });

    await useClipStore.getState().removeSelected();

    expect(useClipStore.getState().lastDeletedIds.sort()).toEqual(['a', 'b']);
  });

  it('删除失败（主进程抛错）时不开撤销窗口：那些行还在列表里，撤销会撤出个空操作', async () => {
    const fake = makeFakeAdapter([item('a')]);
    fake.adapter.items.remove = async () => {
      throw new Error('数据库忙');
    };
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    await useClipStore.getState().remove('a');

    expect(useClipStore.getState().lastDeletedIds).toEqual([]);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('数据库忙');
  });

  it('undoRemove 逐条调 restore，成功后提示恢复条数', async () => {
    const fake = makeFakeAdapter([item('a'), item('b')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    await useClipStore.getState().remove(['a', 'b']);

    await useClipStore.getState().undoRemove();

    expect(fake.restoreCalls.sort()).toEqual(['a', 'b']);
    expect(useClipStore.getState().toasts.at(-1)?.text).toBe('已恢复 2 条');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('ok');
  });

  it('撤销后窗口立即收起：连点两次不会把同一批 restore 两遍', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    await useClipStore.getState().remove('a');

    await useClipStore.getState().undoRemove();
    await useClipStore.getState().undoRemove();

    expect(fake.restoreCalls).toEqual(['a']);
    expect(useClipStore.getState().lastDeletedIds).toEqual([]);
  });

  it('部分失败（duplicate）时如实报两个数字，不假装全部恢复', async () => {
    const fake = makeFakeAdapter([item('a'), item('b')]);
    fake.setRestoreResult((id) => (id === 'a' ? { ok: true } : { ok: false, reason: 'duplicate' }));
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    await useClipStore.getState().remove(['a', 'b']);

    await useClipStore.getState().undoRemove();

    const last = useClipStore.getState().toasts.at(-1);
    expect(last?.text).toBe('已恢复 1 条，1 条同内容已在列表中');
    expect(last?.tone).toBe('warn');
  });

  it('3 秒窗口过期后 undoRemove 是 no-op（不调 restore）', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    await useClipStore.getState().remove('a');
    expect(useClipStore.getState().lastDeletedIds).toEqual(['a']);

    vi.advanceTimersByTime(TOAST_TTL_MS + 1);
    expect(useClipStore.getState().lastDeletedIds).toEqual([]);

    await useClipStore.getState().undoRemove();

    expect(fake.restoreCalls).toEqual([]);
  });

  it('窗口内撤销有效（3 秒是边界：过期前一毫秒仍可撤）', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    await useClipStore.getState().remove('a');

    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    await useClipStore.getState().undoRemove();

    expect(fake.restoreCalls).toEqual(['a']);
  });
});

describe('回收站', () => {
  it('openTrash 切到 trash 视图并拉列表与总数', async () => {
    const fake = makeFakeAdapter([]);
    fake.setTrashSeed([item('t1', { deletedAt: 900 }), item('t2', { deletedAt: 800 })]);
    setPlatform(fake.adapter);

    await useClipStore.getState().openTrash();

    expect(useClipStore.getState().view).toBe('trash');
    expect(useClipStore.getState().trashItems.map((it) => it.id)).toEqual(['t1', 't2']);
    expect(useClipStore.getState().trashTotal).toBe(2);
    expect(fake.trashListCalls[0]).toMatchObject({ limit: TRASH_PAGE_SIZE, offset: 0 });
  });

  it('loadMoreTrash 用已加载条数当下一页 offset', async () => {
    const fake = makeFakeAdapter([]);
    const many = Array.from({ length: TRASH_PAGE_SIZE + 3 }, (_, i) => item('t' + i));
    fake.setTrashSeed(many);
    setPlatform(fake.adapter);
    await useClipStore.getState().openTrash();

    await useClipStore.getState().loadMoreTrash();

    expect(fake.trashListCalls.at(-1)).toMatchObject({ offset: TRASH_PAGE_SIZE });
    expect(useClipStore.getState().trashItems).toHaveLength(TRASH_PAGE_SIZE + 3);
  });

  it('已加载满总数时 loadMoreTrash 不再发请求', async () => {
    const fake = makeFakeAdapter([]);
    fake.setTrashSeed([item('t1')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().openTrash();

    await useClipStore.getState().loadMoreTrash();

    expect(fake.trashListCalls).toHaveLength(1);
  });

  it('restore 遇到 duplicate 时不把这一行从回收站摘掉（它还在回收站里）', async () => {
    const fake = makeFakeAdapter([]);
    fake.setTrashSeed([item('t1'), item('t2')]);
    fake.setRestoreResult(() => ({ ok: false, reason: 'duplicate' }));
    setPlatform(fake.adapter);
    await useClipStore.getState().openTrash();

    await useClipStore.getState().restoreFromTrash('t1');

    expect(fake.restoreCalls).toEqual(['t1']);
    expect(useClipStore.getState().trashItems.map((it) => it.id)).toEqual(['t1', 't2']);
  });

  it('restore 成功后刷新回收站列表与计数', async () => {
    const fake = makeFakeAdapter([]);
    fake.setTrashSeed([item('t1'), item('t2')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().openTrash();
    // 主进程把 t1 恢复后，回收站里只剩 t2。
    fake.setTrashSeed([item('t2')]);

    await useClipStore.getState().restoreFromTrash('t1');

    expect(useClipStore.getState().trashItems.map((it) => it.id)).toEqual(['t2']);
    expect(useClipStore.getState().trashTotal).toBe(1);
  });

  it('purgeFromTrash 用单元素数组调 purge 并刷新列表', async () => {
    const fake = makeFakeAdapter([]);
    fake.setTrashSeed([item('t1')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().openTrash();
    fake.setTrashSeed([]);

    await useClipStore.getState().purgeFromTrash('t1');

    expect(fake.purgeCalls).toEqual([['t1']]);
    expect(useClipStore.getState().trashItems).toEqual([]);
    expect(useClipStore.getState().trashTotal).toBe(0);
  });

  it('emptyTrash 清空并提示条数', async () => {
    const fake = makeFakeAdapter([]);
    fake.setTrashSeed([item('t1'), item('t2')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().openTrash();

    await useClipStore.getState().emptyTrash();

    expect(fake.emptyTrashCalls).toHaveLength(1);
    expect(useClipStore.getState().trashItems).toEqual([]);
    expect(useClipStore.getState().toasts.at(-1)?.text).toBe('已清空回收站（2 条）');
  });

  it('view 不持久化：reset 后回到 list', async () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);
    await useClipStore.getState().openTrash();
    expect(useClipStore.getState().view).toBe('trash');

    resetClipStore();

    expect(useClipStore.getState().view).toBe('list');
  });
});
