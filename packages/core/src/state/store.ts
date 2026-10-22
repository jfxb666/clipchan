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
import {
  GHOST_RESUME_TOAST,
  UNDO_LABEL,
  appToastTone,
  ghostOnToast,
  mergeToast,
  pasteToast,
  removeToast,
  undoToast,
  type ToastAction,
  type ToastTone,
} from '../ui/toastText';
import { TRASH_PAGE_SIZE, nextTrashOffset } from '../ui/trashViewLogic';

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
/** Ctrl+Delete 待确认态的存活时间：超时未再按就作废（与设置页 3 秒复位一致）。 */
export const CLEAR_CONFIRM_TTL_MS = 3000;

/**
 * 顶层视图：列表 / 设置 / 今日词云 / 优化面板 / 回收站 / 片段库（spec §6.9 词云是应用内视图）。
 *
 * ★ 回收站也在这里，但**不持久化**：view 只是内存状态，重启回 'list'（既有行为，别顺手改）。
 */
export type View = 'list' | 'settings' | 'wordcloud' | 'optimize' | 'trash' | 'snippets';
/** 窗口形态：主面板 900×620 / 小组件 280×420（spec §6.6）。 */
export type AppMode = 'main' | 'widget';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  /** 可选的按钮式动作；渲染成提示条右侧的小按钮（Toast.tsx 里与文案是兄弟节点）。 */
  action?: ToastAction;
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
  /** 当前分类/搜索词下的真实总数（不是已加载条数）：状态栏「共 N 条」用它。 */
  total: number;
  loading: boolean;
  settings: Settings;
  ghost: GhostState;
  capabilities: Capabilities;
  hotkeys: HotkeyStatus;
  toasts: Toast[];
  mergeHint: MergeHint | null;
  /** Ctrl+Delete 第一次按下后的待确认态（3 秒内再按才真的清空）。 */
  confirmClear: boolean;
  /** 回收站列表（按删除时间倒序，独立分页，与主列表的 kind/搜索无关）。 */
  trashItems: ClipItemDTO[];
  /** 回收站真实总条数（trashCount）；取不到时为 -1。 */
  trashTotal: number;
  trashLoading: boolean;
  /**
   * 最近一次删除的 id，供「撤销」用。
   * ★ 只在删除成功后才写、3 秒后清空：失败回滚时这些行还在列表里，给撤销只会撤出个空。
   */
  lastDeletedIds: string[];
  wordcloud: WordCloudData | null;
  /** 优化面板的原文初值：由卡片「优化」按钮带出（计划 Task 7 Step 3）。 */
  optimizeSource: string;
}

export interface ClipStoreActions {
  setView(view: View): void;
  /** 打开优化面板并带出原文（列表卡片「优化」按钮）。 */
  openOptimize(text: string): void;
  /** 关闭优化面板并清空原文。 */
  closeOptimize(): void;
  /**
   * 打开片段库（侧栏入口）。
   * ★ 与 openOptimize 分开：片段库不需要带初值，也没有"关闭时清空"的配套状态。
   */
  openSnippets(): void;
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
  /** 撤销最近一次删除：逐条 restore + 重新 load；部分失败时如实报数。 */
  undoRemove(): Promise<void>;
  /**
   * 记录刚删掉的 id 并弹出带「撤销」的提示（3 秒窗口）。
   * 内部动作，但导出到 actions 上便于单测直接驱动。
   */
  armUndo(ids: string[]): void;
  pasteSelected(): Promise<void>;
  mergeSelected(): Promise<void>;
  clearUnpinned(): Promise<void>;
  /** 键盘 Ctrl+Delete：第一次只提示，3 秒内再按一次才执行（与设置页的两次点击确认对齐）。 */
  pressClearUnpinned(): void;
  clearAll(): Promise<void>;
  /** 拉回收站第一页（替换列表）。 */
  loadTrash(): Promise<void>;
  /** 打开回收站并拉第一页（侧栏入口 / 托盘导航）。 */
  openTrash(): Promise<void>;
  /** 回收站滚到底加载下一页。 */
  loadMoreTrash(): Promise<void>;
  /** 从回收站恢复一条；失败（duplicate/missing）时**不移除**这一条，如实提示。 */
  restoreFromTrash(id: string): Promise<void>;
  /** 永久删除回收站里的一条（删盘）。 */
  purgeFromTrash(id: string): Promise<void>;
  /** 清空回收站（全部硬删 + 删盘）。破坏性，调用方负责二次确认。 */
  emptyTrash(): Promise<void>;
  /** 导出全部记录为 zip（设置页「数据」区）。用户取消不算失败，静默返回。 */
  exportAll(): Promise<void>;
  /**
   * 从 zip 备份包导入（设置页「数据」区）。纯加法：重复 id / 哈希一律跳过，绝不覆盖。
   * 成功后的汇总提示由主进程发（它知道四类计数），这里只刷新列表，不重复 toast。
   */
  importAll(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setWidgetSize(px: number): Promise<void>;
  setGhost(minutes: number): Promise<void>;
  /** 本地倒计时；幽灵模式到期或系统时间跳变时用。 */
  tickGhost(): void;
  loadWordCloud(): Promise<void>;
  exportWordCloud(): Promise<void>;
  setAutoStart(on: boolean): Promise<boolean>;
  openDataFolder(): Promise<void>;
  /** 弹一条浮层提示。action 给了就在提示条上渲染成可点按钮（撤销用）。 */
  toast(text: string, tone?: ToastTone, action?: ToastAction): void;
  /**
   * 主进程推来的提示（app:toast）。与本地 toast 共用同一套渲染与自动消失，
   * 单独开一个名字是为了让调用点看得出"这条不是我发的"，将来要改行为（比如去重）也好改。
   */
  pushToast(text: string, tone: ToastTone): void;
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

const INITIAL_HOTKEYS: HotkeyStatus = { activate: false, widget: false, capture: false, conflicts: [] };

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
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
/** 撤销窗口（删除后 3 秒内可反悔）的到期定时器。 */
let undoWindowTimer: ReturnType<typeof setTimeout> | null = null;
let loadSeq = 0;
let toastSeq = 0;
let unsubscribers: (() => void)[] = [];

/** 收起撤销窗口：清定时器 + 丢掉待撤销的 id（幂等）。 */
function clearUndoWindow(): void {
  if (undoWindowTimer) {
    clearTimeout(undoWindowTimer);
    undoWindowTimer = null;
  }
  useClipStore.setState({ lastDeletedIds: [] });
}

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
    total: 0,
    loading: false,
    settings: { ...DEFAULT_SETTINGS },
    ghost: { ...INITIAL_GHOST },
    capabilities: { ...INITIAL_CAPABILITIES },
    hotkeys: { ...INITIAL_HOTKEYS },
    toasts: [],
    mergeHint: null,
    confirmClear: false,
    trashItems: [],
    trashTotal: -1,
    trashLoading: false,
    lastDeletedIds: [],
    wordcloud: null,
    optimizeSource: '',
  };
}

/** 重置到初始状态：单测每个用例之间调用，保证用例互不影响。 */
export function resetClipStore(): void {
  unbindClipStore();
  if (queryTimer) {
    clearTimeout(queryTimer);
    queryTimer = null;
  }
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
  if (undoWindowTimer) {
    clearTimeout(undoWindowTimer);
    undoWindowTimer = null;
  }
  loadSeq = 0;
  useClipStore.setState(initialState());
}

export const useClipStore = create<ClipStore>((set, get) => ({
  ...initialState(),

  setView: (view) => set({ view }),

  openOptimize: (text) => set({ view: 'optimize', optimizeSource: text }),

  closeOptimize: () => set({ view: 'list', optimizeSource: '' }),

  openSnippets: () => set({ view: 'snippets' }),

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
      const platform = getPlatform();
      const query = listQuery(kind, q, 0);
      // 列表与总数必须同一套条件：分开算会出现「共 3 条」但列表有 5 张卡片。
      const [items, counted] = await Promise.all([
        platform.items.list(query),
        // 取不到总数就退回已加载条数（宁可少一个准确数字，也不让整页加载失败）。
        platform.items.count(query).catch(() => -1),
      ]);
      if (seq !== loadSeq) return;
      const ids = new Set(items.map((it) => it.id));
      const kept = get().selectedIds.filter((id) => ids.has(id));
      set({
        // 收藏置顶再入列表：与 SQL 的 ORDER BY pinned DESC, created_at DESC 对齐。
        items: sortItems(items),
        total: counted >= 0 ? counted : items.length,
        hasMore: items.length >= PAGE_SIZE,
        selectedIds: kept,
        selectedId: kept[0] ?? null,
        loading: false,
      });
    } catch (err) {
      if (seq !== loadSeq) return;
      set({ loading: false, hasMore: false, total: 0 });
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

  loadTrash: async () => {
    set({ trashLoading: true });
    try {
      const platform = getPlatform();
      // 列表与总数同一轮取：分开算会出现「回收站（3 条）」下面却挂着 5 张卡片。
      const [items, counted] = await Promise.all([
        platform.items.trashList({ limit: TRASH_PAGE_SIZE, offset: 0 }),
        // 取不到总数退回 -1（nextTrashOffset 对 -1 有专门的保守处理）。
        platform.items.trashCount().catch(() => -1),
      ]);
      set({ trashItems: items, trashTotal: counted, trashLoading: false });
    } catch (err) {
      set({ trashLoading: false, trashItems: [], trashTotal: 0 });
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
      // 删除是本地已确定的减法：同步减总数，否则状态栏会停在旧数字直到下次 load。
      total: Math.max(0, get().total - ids.length),
      selectedIds: kept,
      selectedId: kept[0] ?? null,
    });
    try {
      for (const one of ids) await getPlatform().items.remove(one);
    } catch (err) {
      set({ items: before });
      get().toast(errorText(err), 'error');
      return;
    }
    // ★ 只在**全部删成功**后才开撤销窗口：中途抛错已回滚，那些行还在列表里，
    //   此时给「撤销」会撤出个空操作，用户会以为撤销坏了。
    get().armUndo(ids);
  },

  armUndo: (ids) => {
    if (ids.length === 0) return;
    clearUndoWindow();
    set({ lastDeletedIds: [...ids] });
    const { text, tone } = removeToast(ids.length);
    get().toast(text, tone, {
      label: UNDO_LABEL,
      onClick: () => {
        void get().undoRemove();
      },
    });
    undoWindowTimer = setTimeout(() => {
      undoWindowTimer = null;
      // 窗口过期只清撤销能力，不回收提示条本身（它由 toast 自己的 TTL 管）。
      set({ lastDeletedIds: [] });
    }, TOAST_TTL_MS);
    unref(undoWindowTimer);
  },

  undoRemove: async () => {
    const ids = get().lastDeletedIds;
    if (ids.length === 0) return;
    // 先收起窗口再恢复：连点两次「撤销」不应该把同一批 restore 两遍。
    clearUndoWindow();
    let restored = 0;
    let failed = 0;
    try {
      const platform = getPlatform();
      for (const one of ids) {
        // restore 失败是**结果**不是异常（同内容已在列表 → ok:false）。
        const result = await platform.items.restore(one);
        if (result.ok) restored += 1;
        else failed += 1;
      }
    } catch (err) {
      get().toast(errorText(err), 'error');
      return;
    }
    await get().load();
    const { text, tone } = undoToast(restored, failed);
    get().toast(text, tone);
  },

  openTrash: async () => {
    set({ view: 'trash' });
    await get().loadTrash();
  },

  loadMoreTrash: async () => {
    const { trashLoading, trashItems, trashTotal } = get();
    if (trashLoading) return;
    const offset = nextTrashOffset(trashItems.length, trashTotal);
    if (offset === null) return;
    set({ trashLoading: true });
    try {
      const next = await getPlatform().items.trashList({ limit: TRASH_PAGE_SIZE, offset });
      // 逐页追加；万一主进程在两次请求之间又删了行导致同一 id 回来，按 id 去重。
      const seen = new Set(get().trashItems.map((it) => it.id));
      set({
        trashItems: [...get().trashItems, ...next.filter((it) => !seen.has(it.id))],
        trashLoading: false,
      });
    } catch (err) {
      set({ trashLoading: false });
      get().toast(errorText(err), 'error');
    }
  },

  restoreFromTrash: async (id) => {
    try {
      const result = await getPlatform().items.restore(id);
      if (result.ok) {
        await get().loadTrash();
        // 恢复成功会广播 itemsChanged，但那只驱动主列表；这里主动补一次 load，
        // 让用户在回收站里就能看到主列表数字已经变了（不用等切回列表）。
        await get().load();
        get().toast('已恢复 1 条', 'ok');
        return;
      }
      // ★ duplicate / missing 时**不能**把这条从回收站列表里摘掉：
      //   主进程恢复失败、没有广播 itemsChanged，这一行仍在回收站里，摘掉就是骗人。
      //   duplicate 的提示由主进程 toast 过了（main.ts 的 items:restore 分支），这里不重复。
      if (result.reason !== 'duplicate') {
        get().toast(result.reason === 'missing' ? '这条已经不在回收站里了' : '恢复失败，请重试', 'warn');
        await get().loadTrash();
      }
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  purgeFromTrash: async (id) => {
    try {
      await getPlatform().items.purge([id]);
      await get().loadTrash();
      // 硬删也动了主列表（回收站行本就不在主列表里，但总数/预算可能变），顺手对齐一次。
      await get().load();
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  emptyTrash: async () => {
    try {
      const result = await getPlatform().items.emptyTrash();
      set({ trashItems: [], trashTotal: 0 });
      await get().loadTrash();
      await get().load();
      if (result.removed > 0) get().toast('已清空回收站（' + result.removed + ' 条）', 'ok');
    } catch (err) {
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
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    set({ confirmClear: false });
    try {
      await getPlatform().items.clearUnpinned();
      await get().load();
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  /**
   * 键盘 Ctrl+Delete 的两次确认（与设置页「再点一次确认」同一语义）。
   * 键盘路径没有按钮可以变字，所以第一次按下改成弹一条提示，3 秒内再按才真的清空。
   */
  pressClearUnpinned: () => {
    if (get().confirmClear) {
      void get().clearUnpinned();
      return;
    }
    set({ confirmClear: true });
    get().toast('再按一次 Ctrl+Delete 清空未收藏（3 秒内有效）', 'warn');
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      set({ confirmClear: false });
    }, CLEAR_CONFIRM_TTL_MS);
    unref(confirmTimer);
  },

  clearAll: async () => {
    try {
      await getPlatform().items.clearAll();
      await get().load();
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  exportAll: async () => {
    try {
      const result = await getPlatform().items.exportAll();
      if (result.ok) {
        get().toast('已导出到：' + (result.path ?? ''), 'ok');
        return;
      }
      // ★ 用户在保存对话框点「取消」不是失败：既没落盘也没出错，
      //   弹「导出失败」会让人以为出了故障。静默返回。
      if (result.cancelled) return;
      get().toast('导出失败：' + (result.reason ?? '未知原因'), 'warn');
    } catch (err) {
      get().toast(errorText(err), 'error');
    }
  },

  importAll: async () => {
    try {
      const result = await getPlatform().items.importAll();
      // 取消是正常操作，静默（与导出同一套语义）。
      if (result.cancelled) return;
      if (!result.ok) {
        get().toast('导入失败：' + (result.reason ?? '未知原因'), 'warn');
        return;
      }
      // ★ 成功时不 toast：主进程已经用 importSummaryText 报过「导入 N 条 / 跳过 M 条重复」，
      //   渲染层再弹一遍就是两条重复提示。这里只负责把新数据刷进列表。
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

  toast: (text, tone = 'ok', action) => {
    const id = ++toastSeq;
    // action 只有给了才写进对象：否则 toEqual({id,text,tone}) 的既有断言会因为
    // 多出一个 action: undefined 而失败。
    set({ toasts: [...get().toasts, action ? { id, text, tone, action } : { id, text, tone }] });
    unref(
      setTimeout(() => {
        set({ toasts: get().toasts.filter((t) => t.id !== id) });
      }, TOAST_TTL_MS),
    );
  },

  pushToast: (text, tone) => get().toast(text, tone),

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
    // ★ 主进程主动推的提示（恢复遇重复 / 删盘失败 / 导入汇总）。
    //   放在 bindClipStore 而不是 App 的 useEffect 里：这里已经幂等
    //   （重复挂载返回同一个取消函数），挂两处会叠加监听、同一条提示弹两次。
    platform.app.onToast((t) => {
      get().pushToast(t?.message ?? '', appToastTone(t?.kind ?? 'info'));
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
