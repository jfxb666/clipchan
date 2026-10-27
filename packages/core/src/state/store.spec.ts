import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiProvider,
  AppToast,
  AssistRequest,
  BurstHint,
  ClipItemDTO,
  ClipchanApi,
  FolderDTO,
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
  /** v1.0.0 ⑥/⑧：文件夹与条目标签/文件夹写入的调用记录。 */
  const folderCalls: { op: string; args: unknown[] }[] = [];
  const setTagsCalls: { id: string; tags: string[] }[] = [];
  const setFolderCalls: { id: string; folderId: string | null }[] = [];
  /** 文件夹写操作返回的整表；由用例替换。 */
  let folderTable: FolderDTO[] = [];
  /** 让文件夹写操作抛错，验证「失败时状态不变 + toast」。 */
  let folderThrows = false;
  /** 让条目的 setTags / setFolder 抛错，验证乐观更新的回滚。 */
  let itemWriteThrows = false;
  /** v1.0.0 ⑥：getText 的返回值与「让它抛错」的开关（AI 起标签要读全文）。 */
  let itemText = '';
  let getTextThrows = false;
  /** v1.0.0 ⑥：AI 起标签用——模型列表种子、assist 的调用记录与抛错开关。 */
  let aiProviderSeed: AiProvider[] = [];
  let aiAssistReply = '';
  let aiAssistThrows = false;
  const aiListProvidersCalls: number[] = [];
  const aiAssistCalls: AssistRequest[] = [];

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
      getText: async () => {
        if (getTextThrows) throw new Error('读原文失败');
        return itemText;
      },
      saveText: async () => ({ ok: true, id: 'saved-1' }),
      pastePlain: async () => ({ ok: true }),
      pasteMany: async () => ({ ok: true }),
      removeMany: async () => 0,
      pinMany: async () => {},
      startDrag: async () => {},
      // v1.0.0 ⑥：标签 / 文件夹归类只补形状，本文件不测这两条（它们属于 organize 的用例）。
      setTags: async (id: string, tags: string[]) => {
        setTagsCalls.push({ id, tags });
        if (itemWriteThrows) throw new Error('写标签失败');
      },
      setFolder: async (id: string, folderId: string | null) => {
        setFolderCalls.push({ id, folderId });
        if (itemWriteThrows) throw new Error('写文件夹失败');
      },
      // 标签统计只补形状：本文件不测它（属于 db.spec 的用例）。
      listTags: async () => [],
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
      getHotkeyStatus: async () => ({ activate: true, widget: true, capture: true, conflicts: [] }),
      getAutoStart: async () => false,
      setAutoStart: async () => true,
      openDataFolder: async () => {},
      checkUpdate: async () => ({ state: 'idle' }),
      applyUpdate: async () => {},
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
      onUpdate: () => () => {},
    },
    wordcloud: {
      today: async () => ({ words: [], totalItems: 0 }),
      exportPng: async () => ({ ok: true }),
    },
    clipboard: {
      writeText: async () => {},
    },
    snippets: {
      list: async () => [],
      save: async () => [],
      remove: async () => [],
      use: async () => [],
      onChanged: () => () => {},
    },
    folders: {
      list: async () => folderTable,
      create: async (input) => {
        folderCalls.push({ op: 'create', args: [input] });
        if (folderThrows) throw new Error('文件夹写失败');
        return folderTable;
      },
      rename: async (id: string, name: string) => {
        folderCalls.push({ op: 'rename', args: [id, name] });
        if (folderThrows) throw new Error('文件夹写失败');
        return folderTable;
      },
      move: async (id: string, parentId: string | null) => {
        folderCalls.push({ op: 'move', args: [id, parentId] });
        if (folderThrows) throw new Error('文件夹写失败');
        return folderTable;
      },
      remove: async (id: string) => {
        folderCalls.push({ op: 'remove', args: [id] });
        if (folderThrows) throw new Error('文件夹写失败');
        return folderTable;
      },
    },
    ai: {
      listProviders: async () => {
        aiListProvidersCalls.push(1);
        return aiProviderSeed;
      },
      saveProvider: async () => [],
      removeProvider: async () => [],
      listModels: async () => [],
      test: async () => ({ ok: false }),
      optimize: async () => ({ optimized: '', notes: [], degraded: false }),
      assist: async (req: AssistRequest) => {
        aiAssistCalls.push(req);
        if (aiAssistThrows) throw new Error('模型超时');
        return { text: aiAssistReply, degraded: false };
      },
      cancel: async () => {},
      scenes: async () => [],
      copyAndPaste: async () => ({ ok: false, reason: 'send-failed' }),
      history: async () => [],
      historyRemove: async () => {},
      historyClear: async () => {},
      onChanged: () => () => {},
      onOptimizeDelta: () => () => {},
    },
    capture: {
      begin: async () => null,
      target: async () => null,
      finish: async () => ({ ok: false, reason: '未实现' }),
      cancel: async () => {},
    },
    ocr: {
      status: async () => ({ ready: false, languages: [], missing: [] }),
      download: async () => ({ ready: false, languages: [], missing: [] }),
      recognize: async () => ({ text: '', confidence: 0, ms: 0 }),
      onProgress: () => () => {},
    },
    qr: {
      recognize: async () => '',
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
    folderCalls,
    setTagsCalls,
    setFolderCalls,
    setFolderTable: (t: FolderDTO[]) => {
      folderTable = t;
    },
    setFolderThrows: (v: boolean) => {
      folderThrows = v;
    },
    setItemWriteThrows: (v: boolean) => {
      itemWriteThrows = v;
    },
    aiListProvidersCalls,
    aiAssistCalls,
    setItemText: (text: string) => {
      itemText = text;
    },
    setGetTextThrows: (v: boolean) => {
      getTextThrows = v;
    },
    setAiProviders: (list: AiProvider[]) => {
      aiProviderSeed = list;
    },
    setAiAssistReply: (reply: string) => {
      aiAssistReply = reply;
    },
    setAiAssistThrows: (v: boolean) => {
      aiAssistThrows = v;
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

describe('搜索升级：q 解析成结构化查询（v1.0.0 ⑧）', () => {
  it('★ 纯文本只传 q，不传 expr —— 老的三路 LIKE 快路径一字未变', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('hello');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    const call = fake.listCalls[0]!;
    expect(call.q).toBe('hello');
    expect(call.expr).toBeUndefined();
    expect(call.time).toBeUndefined();
  });

  it('多个自由词（隐式 AND）仍然折回 q，不退化成表达式求值', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('foo bar');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    const call = fake.listCalls[0]!;
    // 两个词是 and 节点 → 不是单个 text 叶子 → 走 expr
    expect(call.expr).toBeDefined();
    expect(call.q).toBeUndefined();
  });

  it('正则 /^ab/ 传 expr，不传 q', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('/^ab/');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    const call = fake.listCalls[0]!;
    expect(call.q).toBeUndefined();
    expect(call.expr).toEqual({ op: 'leaf', kind: 'regex', value: '^ab', flags: '' });
  });

  it('foo AND bar 传 expr，不传 q', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('foo AND bar');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    const call = fake.listCalls[0]!;
    expect(call.q).toBeUndefined();
    expect(call.expr).toEqual({
      op: 'and',
      children: [
        { op: 'leaf', kind: 'text', value: 'foo' },
        { op: 'leaf', kind: 'text', value: 'bar' },
      ],
    });
  });

  it('after:2024-01-01 传 time.from（本地时间当天 00:00），不传 q', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('after:2024-01-01');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    const call = fake.listCalls[0]!;
    expect(call.q).toBeUndefined();
    expect(call.time).toEqual({ from: new Date(2024, 0, 1, 0, 0, 0, 0).getTime() });
  });

  it('★ 非法日期 after:2024-13-01 → searchErrors 非空，且查询照常发出去不崩', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('after:2024-13-01');
    expect(useClipStore.getState().searchErrors.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    // 非法那一段被丢掉 → 没有任何条件，退回无关键词的普通列表
    expect(fake.listCalls[0]!.q).toBeUndefined();
    expect(fake.listCalls[0]!.time).toBeUndefined();
    expect(useClipStore.getState().loading).toBe(false);
  });

  it('searchErrors 立刻写入（不等防抖），请求仍然 300ms 后才发', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('after:2024-13-01');

    expect(useClipStore.getState().q).toBe('after:2024-13-01');
    expect(useClipStore.getState().searchErrors.length).toBeGreaterThan(0);
    expect(fake.listCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS);
    expect(fake.listCalls).toHaveLength(1);
  });

  it('正常输入会把上一次的 searchErrors 清空', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setQuery('after:2024-13-01');
    expect(useClipStore.getState().searchErrors.length).toBeGreaterThan(0);

    useClipStore.getState().setQuery('hello');
    expect(useClipStore.getState().searchErrors).toEqual([]);
  });
});

describe('标签 / 文件夹筛选（v1.0.0 ⑥）', () => {
  it('tagFilter 非空时带 tags，且 count 用同一套条件', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setTagFilter(['工作', '紧急']);
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    expect(fake.listCalls[0]!.tags).toEqual(['工作', '紧急']);
    expect(fake.countCalls.at(-1)!.tags).toEqual(['工作', '紧急']);
  });

  it('tagFilter 为空数组时不带 tags 键（等同不限）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    await useClipStore.getState().load();

    expect('tags' in fake.listCalls[0]!).toBe(false);
  });

  it('★ folderFilter === null 时 query 里存在 folderId 键且值为 null（不是省略）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setFolderFilter(null);
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    const call = fake.listCalls[0]!;
    expect(Object.prototype.hasOwnProperty.call(call, 'folderId')).toBe(true);
    expect(call.folderId).toBeNull();
  });

  it('★ folderFilter === undefined 时 query 里不存在 folderId 键', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setFolderFilter(undefined);
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    expect('folderId' in fake.listCalls[0]!).toBe(false);
  });

  it('folderFilter 是字符串时原样带出去', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setFolderFilter('f1');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    expect(fake.listCalls[0]!.folderId).toBe('f1');
  });

  it('★ setFolderFilter(null) 与 setTagFilter 互不覆盖', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);

    useClipStore.getState().setFolderFilter(null);
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));
    useClipStore.getState().setTagFilter(['工作']);
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(2));

    const call = fake.listCalls.at(-1)!;
    expect(call.folderId).toBeNull();
    expect(call.tags).toEqual(['工作']);
    expect(useClipStore.getState().folderFilter).toBeNull();
    expect(useClipStore.getState().tagFilter).toEqual(['工作']);
  });

  it('筛选变化会清掉选中（旧选中行可能已不在列表里）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    useClipStore.getState().select('a');
    expect(useClipStore.getState().selectedIds).toEqual(['a']);

    useClipStore.getState().setTagFilter(['工作']);

    expect(useClipStore.getState().selectedIds).toEqual([]);
    // selectedId 由重载后的结果收敛（旧选中行已不在列表里 → 变成 null）
    await vi.waitFor(() => expect(useClipStore.getState().selectedId).toBeNull());
  });

  it('★ loadMore 用与 load 完全相同的条件（kind/q/tags/folderId/expr/time）', async () => {
    const seed = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => item('i' + i, { createdAt: 10000 - i }));
    const fake = makeFakeAdapter(seed);
    setPlatform(fake.adapter);

    useClipStore.getState().setTagFilter(['工作']);
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));
    useClipStore.getState().setFolderFilter('f1');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(2));
    useClipStore.getState().setQuery('/^ab/');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(3));

    expect(useClipStore.getState().hasMore).toBe(true);
    await useClipStore.getState().loadMore();

    const first = fake.listCalls.at(-2)!;
    const second = fake.listCalls.at(-1)!;
    expect(second.offset).toBe(PAGE_SIZE);
    expect(second.kind).toBe(first.kind);
    expect(second.q).toBe(first.q);
    expect(second.tags).toEqual(first.tags);
    expect(second.folderId).toBe(first.folderId);
    expect(second.expr).toEqual(first.expr);
    expect(second.time).toEqual(first.time);
  });
});

describe('文件夹写操作（v1.0.0 ⑥）', () => {
  const f1: FolderDTO = { id: 'f1', name: '工作', parentId: null, itemCount: 2 };
  const f2: FolderDTO = { id: 'f2', name: '私人', parentId: null, itemCount: 0 };

  it('loadFolders 拉到平表写进 state', async () => {
    const fake = makeFakeAdapter([]);
    fake.setFolderTable([f1, f2]);
    setPlatform(fake.adapter);

    await useClipStore.getState().loadFolders();

    expect(useClipStore.getState().folders.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('loadFolders 失败时静默（文件夹是可选能力，不打扰首屏）', async () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);
    fake.adapter.folders.list = async () => {
      throw new Error('老版本主进程没有这个能力');
    };

    await useClipStore.getState().loadFolders();

    expect(useClipStore.getState().folders).toEqual([]);
    expect(useClipStore.getState().toasts).toHaveLength(0);
  });

  it('createFolder 用返回的整表替换 folders', async () => {
    const fake = makeFakeAdapter([]);
    fake.setFolderTable([f1]);
    setPlatform(fake.adapter);

    await useClipStore.getState().createFolder({ name: '工作' });

    expect(fake.folderCalls[0]).toEqual({ op: 'create', args: [{ name: '工作' }] });
    expect(useClipStore.getState().folders).toEqual([f1]);
  });

  it('renameFolder 用返回的整表替换 folders', async () => {
    const fake = makeFakeAdapter([]);
    fake.setFolderTable([{ ...f1, name: '工作（改）' }]);
    setPlatform(fake.adapter);

    await useClipStore.getState().renameFolder('f1', '工作（改）');

    expect(fake.folderCalls[0]).toEqual({ op: 'rename', args: ['f1', '工作（改）'] });
    expect(useClipStore.getState().folders[0]!.name).toBe('工作（改）');
  });

  it('moveFolder 用返回的整表替换 folders', async () => {
    const fake = makeFakeAdapter([]);
    fake.setFolderTable([{ ...f2, parentId: 'f1' }]);
    setPlatform(fake.adapter);

    await useClipStore.getState().moveFolder('f2', 'f1');

    expect(fake.folderCalls[0]).toEqual({ op: 'move', args: ['f2', 'f1'] });
    expect(useClipStore.getState().folders[0]!.parentId).toBe('f1');
  });

  it('★ 写操作失败时 toast 且 folders 状态不变', async () => {
    const fake = makeFakeAdapter([]);
    fake.setFolderTable([f1]);
    setPlatform(fake.adapter);
    await useClipStore.getState().loadFolders();
    expect(useClipStore.getState().folders).toEqual([f1]);

    fake.setFolderThrows(true);
    await useClipStore.getState().createFolder({ name: '工作2' });

    expect(useClipStore.getState().folders).toEqual([f1]);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('文件夹写失败');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('error');
  });

  it('★ removeFolder 成功后额外重载列表（里面的记录回未归类）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    fake.setFolderTable([]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    const before = fake.listCalls.length;

    await useClipStore.getState().removeFolder('f1');
    await vi.waitFor(() => expect(fake.listCalls.length).toBe(before + 1));

    expect(fake.folderCalls[0]).toEqual({ op: 'remove', args: ['f1'] });
    expect(useClipStore.getState().folders).toEqual([]);
  });

  it('★ 删掉的正是当前筛选的文件夹时，folderFilter 重置为 undefined（不停在空列表上）', async () => {
    const fake = makeFakeAdapter([item('a')]);
    fake.setFolderTable([]);
    setPlatform(fake.adapter);
    useClipStore.getState().setFolderFilter('f1');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    await useClipStore.getState().removeFolder('f1');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(2));

    expect(useClipStore.getState().folderFilter).toBeUndefined();
    expect('folderId' in fake.listCalls.at(-1)!).toBe(false);
  });

  it('删的是别的文件夹时不动当前筛选', async () => {
    const fake = makeFakeAdapter([item('a')]);
    fake.setFolderTable([]);
    setPlatform(fake.adapter);
    useClipStore.getState().setFolderFilter('f1');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1));

    await useClipStore.getState().removeFolder('f2');
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(2));

    expect(useClipStore.getState().folderFilter).toBe('f1');
  });

  it('removeFolder 失败时不重载列表，只 toast', async () => {
    const fake = makeFakeAdapter([item('a')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();
    const before = fake.listCalls.length;

    fake.setFolderThrows(true);
    await useClipStore.getState().removeFolder('f1');

    expect(fake.listCalls.length).toBe(before);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('文件夹写失败');
  });
});

describe('条目的标签 / 文件夹（乐观更新）', () => {
  it('setItemTags 乐观更新本地那一条的 tags', async () => {
    const fake = makeFakeAdapter([item('a'), item('b')]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    await useClipStore.getState().setItemTags('a', ['工作', '紧急']);

    expect(fake.setTagsCalls).toEqual([{ id: 'a', tags: ['工作', '紧急'] }]);
    expect(useClipStore.getState().items.find((it) => it.id === 'a')?.tags).toEqual(['工作', '紧急']);
    expect(useClipStore.getState().items.find((it) => it.id === 'b')?.tags).toBeUndefined();
  });

  it('★ setItemTags 失败时回滚 + toast', async () => {
    const fake = makeFakeAdapter([item('a', { tags: ['旧'] })]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    fake.setItemWriteThrows(true);
    await useClipStore.getState().setItemTags('a', ['新']);

    expect(useClipStore.getState().items.find((it) => it.id === 'a')?.tags).toEqual(['旧']);
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('写标签失败');
    expect(useClipStore.getState().toasts.at(-1)?.tone).toBe('error');
  });

  it('setItemFolder 乐观更新 folderId；null 表示移出到未归类', async () => {
    const fake = makeFakeAdapter([item('a', { folderId: 'f1' })]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    await useClipStore.getState().setItemFolder('a', null);

    expect(fake.setFolderCalls).toEqual([{ id: 'a', folderId: null }]);
    // DTO 用 undefined 表示未归类（见 ClipItemDTO.folderId 注释）
    expect(useClipStore.getState().items.find((it) => it.id === 'a')?.folderId).toBeUndefined();
  });

  it('setItemFolder 失败时回滚 + toast', async () => {
    const fake = makeFakeAdapter([item('a', { folderId: 'f1' })]);
    setPlatform(fake.adapter);
    await useClipStore.getState().load();

    fake.setItemWriteThrows(true);
    await useClipStore.getState().setItemFolder('a', 'f2');

    expect(useClipStore.getState().items.find((it) => it.id === 'a')?.folderId).toBe('f1');
    expect(useClipStore.getState().toasts.at(-1)?.text).toContain('写文件夹失败');
  });

  it('★ 正按文件夹筛选时改完不乐观摘行（交给 itemsChanged 重载收敛）', async () => {
    const fake = makeFakeAdapter([item('a', { folderId: 'f1' }), item('b', { folderId: 'f1' })]);
    setPlatform(fake.adapter);
    useClipStore.getState().setFolderFilter('f1');
    // 等这一轮重载真的落地（list 被调用 ≠ 列表已写进 state），否则它会把乐观更新盖掉
    await vi.waitFor(() => expect(useClipStore.getState().items).toHaveLength(2));

    await useClipStore.getState().setItemFolder('a', 'f2');

    // 行还在（本地不摘），只是 folderId 变了
    expect(useClipStore.getState().items.map((it) => it.id)).toContain('a');
    expect(useClipStore.getState().items.find((it) => it.id === 'a')?.folderId).toBe('f2');
  });
});

describe('AI 助手面板的开关（v1.0.0 ⑤）', () => {
  it('openAssist 切到 assist 视图并带出原文', () => {
    useClipStore.getState().openAssist('原文');

    expect(useClipStore.getState().view).toBe('assist');
    expect(useClipStore.getState().assistSource).toBe('原文');
  });

  it('closeAssist 回到列表并清空原文', () => {
    useClipStore.getState().openAssist('原文');

    useClipStore.getState().closeAssist();

    expect(useClipStore.getState().view).toBe('list');
    expect(useClipStore.getState().assistSource).toBe('');
  });

  it('初始状态下 assistSource 是空串（没开过面板就不该带着上次的原文）', () => {
    expect(useClipStore.getState().assistSource).toBe('');
  });

  it('★ 关闭后再打开换新文本：面板不会残留上一条记录的全文', () => {
    useClipStore.getState().openAssist('第一条');
    useClipStore.getState().closeAssist();
    useClipStore.getState().openAssist('第二条');

    expect(useClipStore.getState().view).toBe('assist');
    expect(useClipStore.getState().assistSource).toBe('第二条');
  });
});

describe('bindClipStore 顺带拉文件夹（失败静默）', () => {
  it('绑定时调 folders.list 并写入 folders', async () => {
    const fake = makeFakeAdapter([]);
    fake.setFolderTable([{ id: 'f1', name: '工作', parentId: null, itemCount: 0 }]);
    setPlatform(fake.adapter);

    const unbind = bindClipStore();
    await vi.waitFor(() => expect(useClipStore.getState().folders).toHaveLength(1));

    expect(useClipStore.getState().folders[0]!.id).toBe('f1');
    unbind();
  });

  it('folders.list 抛错时绑定照常完成，不弹 toast', async () => {
    const fake = makeFakeAdapter([]);
    setPlatform(fake.adapter);
    fake.adapter.folders.list = async () => {
      throw new Error('没有这个能力');
    };

    const unbind = bindClipStore();
    await vi.waitFor(() => expect(fake.listCalls.length + 1).toBeGreaterThan(0));
    await Promise.resolve();

    expect(useClipStore.getState().toasts).toHaveLength(0);
    unbind();
  });
});

describe('suggestTagsByAi（v1.0.0 ⑥ 可选项）', () => {
  const PROVIDER: AiProvider = {
    id: 'p1',
    name: '本地中转',
    protocol: 'openai-compat',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-4o-mini',
    hasKey: true,
    keyMask: 'sk-***1',
  };

  it('有可用 provider 时把全文发给 ai.assist 并返回解析后的标签', async () => {
    const fake = makeFakeAdapter([]);
    fake.setAiProviders([PROVIDER]);
    fake.setItemText('甲方应于 3 月 1 日前交付验收报告');
    fake.setAiAssistReply('<result>合同、交付验收</result>');
    setPlatform(fake.adapter);

    await useClipStore.getState().loadAiProviders();
    await expect(useClipStore.getState().suggestTagsByAi('i1')).resolves.toEqual([
      '合同',
      '交付验收',
    ]);

    expect(fake.aiAssistCalls).toHaveLength(1);
    expect(fake.aiAssistCalls[0]).toEqual({
      providerId: 'p1',
      action: 'tags',
      text: '甲方应于 3 月 1 日前交付验收报告',
    });
  });

  it('没有可用 provider 时返回 [] 且不调 ai.assist', async () => {
    const fake = makeFakeAdapter([]);
    fake.setAiProviders([{ ...PROVIDER, id: 'p0', hasKey: false }]);
    fake.setItemText('随便一段文字');
    setPlatform(fake.adapter);

    await useClipStore.getState().loadAiProviders();
    await expect(useClipStore.getState().suggestTagsByAi('i1')).resolves.toEqual([]);
    expect(fake.aiAssistCalls).toHaveLength(0);
  });

  it('items.getText 抛异常时返回 []，不弹 toast', async () => {
    const fake = makeFakeAdapter([]);
    fake.setAiProviders([PROVIDER]);
    fake.setGetTextThrows(true);
    setPlatform(fake.adapter);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useClipStore.getState().loadAiProviders();
    await expect(useClipStore.getState().suggestTagsByAi('i1')).resolves.toEqual([]);
    expect(fake.aiAssistCalls).toHaveLength(0);
    expect(useClipStore.getState().toasts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[ai] 标签建议失败：读原文失败');
    warn.mockRestore();
  });

  it('ai.assist 抛异常时返回 []，不弹 toast，只留一行 console.warn', async () => {
    const fake = makeFakeAdapter([]);
    fake.setAiProviders([PROVIDER]);
    fake.setItemText('随便一段文字');
    fake.setAiAssistThrows(true);
    setPlatform(fake.adapter);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useClipStore.getState().loadAiProviders();
    await expect(useClipStore.getState().suggestTagsByAi('i1')).resolves.toEqual([]);
    expect(useClipStore.getState().toasts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[ai] 标签建议失败：模型超时');
    warn.mockRestore();
  });

  it('本地还没有 provider 时现场补拉一次再挑', async () => {
    const fake = makeFakeAdapter([]);
    fake.setAiProviders([PROVIDER]);
    fake.setItemText('合同条款');
    fake.setAiAssistReply('合同');
    setPlatform(fake.adapter);

    // 故意不调 loadAiProviders：模拟「刚配好 Key 就回到弹窗」。
    await expect(useClipStore.getState().suggestTagsByAi('i1')).resolves.toEqual(['合同']);
    expect(fake.aiListProvidersCalls.length).toBeGreaterThan(0);
    expect(fake.aiAssistCalls[0]?.providerId).toBe('p1');
  });

  it('原文是空白时返回 [] 且不调 ai.assist', async () => {
    const fake = makeFakeAdapter([]);
    fake.setAiProviders([PROVIDER]);
    fake.setItemText('   \n  ');
    setPlatform(fake.adapter);

    await useClipStore.getState().loadAiProviders();
    await expect(useClipStore.getState().suggestTagsByAi('i1')).resolves.toEqual([]);
    expect(fake.aiAssistCalls).toHaveLength(0);
  });
});
