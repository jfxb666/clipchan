import { create } from 'zustand';
import type {
  Capabilities,
  ClipItemDTO,
  GhostState,
  HotkeyStatus,
  KindFilter,
  ListQuery,
  Settings,
  WordCloudData,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { getPlatform } from '../platform/adapter';
import { GHOST_RESUME_TOAST, ghostOnToast, mergeToast, pasteToast, type ToastTone } from '../ui/toastText';

/**
 * 界面状态中心（spec §5：core 不认宿主，系统能力一律走 getPlatform()）。
 *
 * 这里刻意不 import 任何 electron / node 模块：同一个 store 既跑在 Electron
 * 渲染进程里，也跑在浏览器预览与 Node 单测里。系统能力由平台适配器提供，
 * 单测用 setPlatform() 注入假实现。
 *
 * 列表分页：items.list({ limit: 200, offset }) 滚到底拉下一页；卡片用 CSS
 * content-visibility 做长列表裁剪，不引虚拟滚动库（spec §8.1）。
 */

/** 每页条数（spec §8.1：limit 200）。 */
export const PAGE_SIZE = 200;
/** 搜索防抖（spec §7.7 实时过滤；连打多次只发一次请求）。 */
export const QUERY_DEBOUNCE_MS = 300;
/** 浮层提示停留时长。 */
export const TOAST_TTL_MS = 3000;

/** 顶层视图：列表 / 设置 / 今日词云（spec §6.9 词云是应用内视图）。 */
export type View = 'list' | 'settings' | 'wordcloud';
/** 窗口形态：主面板 900×620 / 小组件 280×420（spec §6.6）。 */
export type AppMode = 'main' | 'widget';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

/** 连续复制的预选提示（spec §7.5：只预选，不自动合并）。 */
export interface MergeHint {
  count: number;
}

export interface ClipStoreState {
  view: View;
  mode: AppMode;
  kind: KindFilter;
  q: string;
  items: ClipItemDTO[];
  /** 主选中项（列表键盘焦点），等价于 selectedIds[0]。 */
  selectedId: string | null;
  /** 多选：Ctrl / Shift + 单击进候选，用于 Ctrl+M 拼接（spec §6.5）。 */
  selectedIds: string[];
  hoveredId: string | null;
  hasMore: boolean;
  loading: boolean;
  settings: Settings;
  ghost: GhostState;
  capabilities: Capabilities;
  hotkeys: HotkeyStatus;
  toasts: Toast[];
  mergeHint: MergeHint | null;
  wordcloud: WordCloudData | null;
}

export interface ClipStoreActions {
  setView(view: View): void;
  setMode(mode: AppMode): void;
  /** 切侧栏分类：清空选中并立刻重新请求（不走防抖）。 */
  setKind(kind: KindFilter): void;
  /** 搜索词：防抖 300ms 后请求，连打多次只发一次。 */
  setQuery(q: string): void;
  /** 首屏 / 重新加载（offset 0，替换列表）。 */
  load(): Promise<void>;
  /** 滚到底加载下一页；hasMore=false 时不发请求。 */
  loadMore(): Promise<void>;
  select(id: string | null, opts?: { multi?: boolean }): void;
  moveSelection(delta: number): void;
  setHovered(id: string | null): void;
  togglePin(id: string): Promise<void>;
  remove(id: string | string[]): Promise<void>;
  removeSelected(): Promise<void>;
  pasteSelected(): Promise<void>;
  mergeSelected(): Promise<void>;
  clearUnpinned(): Promise<void>;
  clearAll(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setWidgetSize(px: number): Promise<void>;
  setGhost(minutes: number): Promise<void>;
  /** 本地倒计时；幽灵模式到期或系统时间跳变时用。 */
  tickGhost(): void;
  loadWordCloud(): Promise<void>;
  exportWordCloud(): Promise<void>;
  setAutoStart(on: boolean): Promise<boolean>;
  openDataFolder(): Promise<void>;
  /** 弹一条浮层提示。 */
  toast(text: string, tone?: ToastTone): void;
  dismissToast(id: number): void;
  setMergeHint(hint: MergeHint | null): void;
  /** 主进程发来连续复制提示：预选这几条 + 浮出提示条（**不合并**，spec §7.5）。 */
  applyBurstHint(ids: string[], count: number): void;
}

export type ClipStore = ClipStoreState & ClipStoreActions;

const INITIAL_CAPABILITIES: Capabilities = {
  autoPaste: false,
  globalHotkey: false,
  backgroundCapture: false,
  frostedGlass: false,
};

const INITIAL_GHOST: GhostState = { active: false, remainingMs: 0, until: null };

const INITIAL_HOTKEYS: HotkeyStatus = { activate: false, widget: false, conflicts: [] };

/** 收藏置顶 → 时间倒序（与 SQL 的 ORDER BY pinned DESC, created_at DESC 一致）。 */
function sortItems(items: ClipItemDTO[]): ClipItemDTO[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 拼 ListQuery：空搜索词不带 q，交给主进程按"无过滤"处理。 */
function listQuery(kind: KindFilter, q: string, offset: number): ListQuery {
  const query: ListQuery = { kind, limit: PAGE_SIZE, offset };
  const keyword = q.trim();
  if (keyword) query.q = keyword;
  return query;
}

// 防抖定时器与请求序号放在模块作用域：同一个渲染进程只应有一份。
let queryTimer: ReturnType<typeof setTimeout> | null = null;
let loadSeq = 0;
let toastSeq = 0;
let unsubscribers: (() => void)[] = [];

/** 定时器在 Node 里 unref，避免单测被挂住的定时器拖住。 */
function unref(timer: ReturnType<typeof setTimeout>): void {
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === 'function') t.unref();
}

/**
 * 主题落到 :root[data-theme]。浏览器/Electron 里生效；Node 单测里 document 不存在，
 * 静默跳过（这样 store 可以在纯 Node 环境里被断言）。
 */
function applyTheme(theme: Settings['theme']): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

/** 初始状态（每次取一份新对象，避免共享可变数组）。 */
function initialState(): ClipStoreState {
  return {
    view: 'list',
    mode: 'main',
    kind: 'all',
    q: '',
    items: [],
    selectedId: null,
    selectedIds: [],
    hoveredId: null,
    hasMore: false,
    loading: false,
    settings: { ...DEFAULT_SETTINGS },
    ghost: { ...INITIAL_GHOST },
    capabilities: { ...INITIAL_CAPABILITIES },
    hotkeys: { ...INITIAL_HOTKEYS },
    toasts: [],
    mergeHint: null,
    wordcloud: null,
  };
}

/** 重置到初始状态：单测每个用例之间调用，保证用例互不影响。 */
export function resetClipStore(): void {
  unbindClipStore();
  if (queryTimer) {
    clearTimeout(queryTimer);
    queryTimer = null;
  }
  loadSeq = 0;
  useClipStore.setState(initialState());
}

export const useClipStore = create<ClipStore>((set, get) => ({
  ...initialState(),

  setView: (view) => set({ view }),

  setMode: (mode) => set({ mode }),

  setKind: (kind) => {
    if (get().kind === kind) return;
    set({ kind, selectedIds: [], mergeHint: null });
    void get().load();
  },

  setQuery: (q) => {
    set({ q });
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      queryTimer = null;
      void get().load();
    }, QUERY_DEBOUNCE_MS);
  },

  load: async () => {
    const { kind, q } = get();
    const seq = ++loadSeq;
    set({ loading: true });
    try {
      const items = await getPlatform().items.list(listQuery(kind, q, 0));
      if (seq !== loadSeq) return;
      const ids = new Set(items.map((it) => it.id));
      const kept = get().selectedIds.filter((id) => ids.has(id));
      set({
        // 收藏置顶再入列表：与 SQL 的 ORDER BY pinned DESC, created_at DESC 对齐。
        items: sortItems(items),
        hasMore: items.length >= PAGE_SIZE,
        selectedIds: kept,
        selectedId: kept[0] ?? null,
        loading: false,
      });
    } catch (err) {
      if (seq !== loadSeq) return;
      set({ loading: false, hasMore: false });
      get().toast(errorText(err), 'error');
    }
  },

  loadMore: async () => {
    const { hasMore, loading, items, kind, q } = get();
    if (!hasMore || loading) return;
    const seq = loadSeq;
    set({ loading: true });
    try {
      const next = await getPlatform().items.list(listQuery(kind, q, items.length));
      if (seq !== loadSeq) return;
      set({
        items: [...get().items, ...next],
        hasMore: next.length >= PAGE_SIZE,
        loading: false,
      });
    } catch (err) {
      if (seq !== loadSeq) return;
      set({ loading: false });
      get().toast(errorText(err), 'error');
    }
  },

  select: (id, opts) => {
    if (!id) {
      set({ selectedId: null, selectedIds: [], mergeHint: null });
      return;
    }
    const multi = opts?.multi ?? false;
    if (!multi) {
      set({ selectedId: id, selectedIds: [id], mergeHint: null });
      return;
    }
    const current = get().selectedIds;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    set({ selectedIds: next, selectedId: next[0] ?? null, mergeHint: null });
  },

  moveSelection: (delta) => {
    const { items, selectedIds } = get();
    if (items.length === 0) return;
    const currentId = selectedIds[0] ?? null;
    const index = currentId ? items.findIndex((it) => it.id === currentId) : -1;
    const nextIndex = Math.min(items.length - 1, Math.max(0, index < 0 ? (delta > 0 ? 0 : items.length - 1) : index + delta));
    const target = items[nextIndex];
    if (target) set({ selectedId: target.id, selectedIds: [target.id], mergeHint: null });
  },

  setHovered: (id) => set({ hoveredId: id }),

  togglePin: async (id) => {
    const before = get().items;
    const next = before.map((it) => (it.id === id ? { ...it, pinned: !it.pinned } : it));
    // 乐观更新：星标立刻翻面、收藏项立刻置顶；失败再回滚。
    set({ items: sortItems(next) });
    try {
      await getPlatform().items.togglePin(id);
    } catch (err) {
      set({ items: before });
      get().toast(errorText(err), 'error');
    }
  },

  remove: async (id) => {
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) return;
    const before = get().items;
    const gone = new Set(ids);
    const kept = get().selectedIds.filter((x) => !gone.has(x));
    set({
      items: before.filter((it) => !gone.has(it.id)),
      selectedIds: kept,
      selectedId: kept[0] ?? null,
    });
    try {
      for (const one of ids) await getPlatform().items.remove(one);
    } catch (err) {
      set({ items: before });
      get().toast(errorText(err), 'error');
    }
  },

  removeSelected: async () => {
    const ids = get().selectedIds;
    if (ids.length === 0) return;
    await get().remove(ids);
  },

  pasteSelected: async () => {
    const { selectedIds, items } = get();
    const id = selectedIds[0] ?? items[0]?.id;
    if (!id) return;
    try {
      const result = await getPlatform().items.paste(id);
      const { text, tone } = pasteToast(result);
      get().toast(text, tone);
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  mergeSelected: async () => {
    const { selectedIds, items } = get();
    const chosen = items.filter((it) => selectedIds.includes(it.id));
    const skippedImages = chosen.filter((it) => it.kind === 'image').length;
    const texts = chosen.filter((it) => it.kind !== 'image');
    const pinned = texts.filter((it) => it.pinned).length;
    const eligible = texts.filter((it) => !it.pinned);

    // spec §7.5：去图片、去收藏后不足 2 条时什么都不做，只提示。
    if (eligible.length < 2) {
      const reason = skippedImages > 0 && texts.length < 2 ? 'images-skipped' : pinned > 0 ? 'pinned' : 'not-enough';
      const { text, tone } = mergeToast({ ok: false, reason }, chosen.length, skippedImages);
      get().toast(text, tone);
      return;
    }
    try {
      const result = await getPlatform().items.mergeSelected(eligible.map((it) => it.id));
      const { text, tone } = mergeToast(result, eligible.length, skippedImages);
      get().toast(text, tone);
      if (result.ok && result.id) {
        set({ selectedId: result.id, selectedIds: [result.id], mergeHint: null });
      }
      await get().load();
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  clearUnpinned: async () => {
    try {
      await getPlatform().items.clearUnpinned();
      await get().load();
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  clearAll: async () => {
    try {
      await getPlatform().items.clearAll();
      await get().load();
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  updateSettings: async (patch) => {
    const before = get().settings;
    const merged = { ...before, ...patch };
    set({ settings: merged });
    if (patch.theme) applyTheme(patch.theme);
    try {
      const saved = await getPlatform().settings.set(patch);
      set({ settings: saved });
      if (saved.theme !== merged.theme) applyTheme(saved.theme);
      if (patch.widgetSize !== undefined && patch.widgetSize !== before.widgetSize) {
        await getPlatform().app.setWidgetSize(saved.widgetSize);
      }
    } catch (err) {
      set({ settings: before });
      applyTheme(before.theme);
      get().toast(errorText(err), 'error');
    }
  },

  setWidgetSize: async (px) => {
    await get().updateSettings({ widgetSize: px });
  },

  setGhost: async (minutes) => {
    try {
      const ghost = await getPlatform().ghost.set(minutes);
      set({ ghost });
      get().toast(minutes > 0 ? ghostOnToast(minutes) : GHOST_RESUME_TOAST, minutes > 0 ? 'warn' : 'ok');
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  tickGhost: () => {
    const ghost = get().ghost;
    if (!ghost.active || ghost.until === null) return;
    const remainingMs = Math.max(0, ghost.until - Date.now());
    if (remainingMs <= 0) {
      set({ ghost: { active: false, remainingMs: 0, until: null } });
      return;
    }
    set({ ghost: { active: true, remainingMs, until: ghost.until } });
  },

  loadWordCloud: async () => {
    try {
      set({ wordcloud: await getPlatform().wordcloud.today() });
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  exportWordCloud: async () => {
    try {
      const result = await getPlatform().wordcloud.exportPng();
      get().toast(result.ok ? '词云已导出' : '导出失败', result.ok ? 'ok' : 'warn');
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  setAutoStart: async (on) => {
    try {
      return await getPlatform().app.setAutoStart(on);
    } catch (err) {
      get().toast(errorText(err), 'error');
      return false;
    }
  },

  openDataFolder: async () => {
    try {
      await getPlatform().app.openDataFolder();
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  toast: (text, tone = 'ok') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    unref(
      setTimeout(() => {
        set({ toasts: get().toasts.filter((t) => t.id !== id) });
      }, TOAST_TTL_MS),
    );
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setMergeHint: (hint) => set({ mergeHint: hint }),

  applyBurstHint: (ids, count) => {
    // 只保留还在列表里的 id（期间可能被删 / 被搜索过滤掉）。
    const known = new Set(get().items.map((it) => it.id));
    const kept = (Array.isArray(ids) ? ids : []).filter((id) => known.has(id));
    if (kept.length === 0) {
      set({ mergeHint: { count } });
      return;
    }
    set({ selectedIds: kept, selectedId: kept[0] ?? null, mergeHint: { count } });
  },
}));

/**
 * 把 store 接到平台事件上：条目变化、设置变化、幽灵状态变化、形态切换。
 * 返回取消订阅函数（组件卸载 / 单测清理时调用）。
 */
export function bindClipStore(): () => void {
  // 幂等：已经订阅过就返回同一个取消函数，避免同一次挂载重复订阅事件。
  if (unsubscribers.length > 0) return unbindClipStore;
  const platform = getPlatform();
  const set = useClipStore.setState;
  const get = useClipStore.getState;

  set({ capabilities: { ...platform.capabilities } });

  unsubscribers = [
    platform.items.onChanged(() => {
      void get().load();
    }),
    platform.settings.onChanged((settings) => {
      set({ settings });
      applyTheme(settings.theme);
    }),
    platform.ghost.onChanged((ghost) => {
      const wasActive = get().ghost.active;
      set({ ghost });
      // 幽灵模式刚结束：提示"监听已恢复"（spec §11 第 28 条）。
      if (wasActive && !ghost.active) get().toast(GHOST_RESUME_TOAST, 'ok');
    }),
    platform.app.onMode((mode) => {
      set({ mode });
    }),
    platform.items.onBurstHint((hint) => {
      get().applyBurstHint(hint?.ids ?? [], hint?.count ?? 0);
    }),
    platform.app.onNavigate((target) => {
      // 托盘「设置…」与热键唤出：切视图；词云要先拉数据（spec §6.9）。
      set({ view: target });
      if (target === 'wordcloud') void get().loadWordCloud();
    }),
  ];
  return unbindClipStore;
}

/** 取消所有平台订阅。 */
export function unbindClipStore(): void {
  for (const off of unsubscribers) {
    try {
      off();
    } catch {
      // 取消订阅失败不应影响界面
    }
  }
  unsubscribers = [];
}

/**
 * 把当前主题写到 :root[data-theme]。
 * theme='auto' 时 CSS 的 prefers-color-scheme 会接管，这里只是把选择落成属性。
 */
export function applyStoredTheme(): void {
  applyTheme(useClipStore.getState().settings.theme);
}
