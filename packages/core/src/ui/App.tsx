import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, CalendarClock, Columns2, LayoutGrid, List, Settings2, Sparkles } from 'lucide-react';
import type {
  AiError,
  AiProvider,
  AiProviderInput,
  OcrProgress,
  OcrResult,
  OcrStatus,
  OptimizeDelta,
  OptimizeRequest,
  Settings,
  Snippet,
  SnippetInput,
  UpdateStatus,
} from '../types';
import { getPlatform } from '../platform/adapter';
import { bindClipStore, useClipStore, type AppMode, type View } from '../state/store';
import { ListPanel } from './ListPanel';
import { ResizeHandles } from './ResizeHandles';
import { SearchBar } from './SearchBar';
import { SettingsView } from './SettingsView';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { ToastStack } from './Toast';
import { TrashView } from './TrashView';
import { copyToast, pasteToast, type ToastTone } from './toastText';
import { ContextMenu } from './ContextMenuView';
import { menuItemsFor, type MenuAction } from './contextMenu';
import { TextViewer } from './TextViewer';
import { OcrResultView } from './OcrResultView';
import { viewerKindOf, viewerTitleOf } from './viewer';
import { WidgetView, WIDGET_PREVIEW_COUNT } from './WidgetView';
import { widgetWindowHeight } from './widgetFit';
import { OptimizeView } from './OptimizeViewCard';
import { ocrErrorText, ocrSavedToast } from './ocrView';
import { WordCloudView } from './WordCloudView';
import { resolveKey, shouldPreventDefault } from './keymap';
import { useAutoStart, useHotkeyStatus } from './usePlatformValue';
import { SnippetView } from './SnippetViewCard';
import { batchActions, batchBarText, canBatchRemove } from './batchBar';
import { cn } from './util';

/**
 * 应用外壳（spec §6.3）：主面板 900×620，自定义标题栏 + 64px 侧栏 + 搜索栏 + 卡片列表。
 *
 * 键盘（spec §7.7）：↑/↓ 移动、Enter 粘贴、Esc 隐藏面板、Ctrl+D 收藏、
 * Ctrl+M 拼接、Delete 删除、Ctrl+Delete 清空未收藏、Ctrl+F 聚焦搜索框。
 */
/** 连续复制提示条的存活时间（spec §7.5：5 秒后淡出，选中保持不动）。 */
const MERGE_HINT_TTL_MS = 5000;

/** 右键菜单的落点（屏幕坐标，由 ClipCard 的 clientX/clientY 带出）。 */
interface MenuAnchor {
  id: string;
  x: number;
  y: number;
}

/** 全文 / 大图浮层的状态：内容异步取，取之前先开壳显示「正在读取…」。 */
interface ViewerState {
  id: string;
  kind: 'text' | 'image';
  title: string;
  text?: string;
  imageUrl?: string;
  loading: boolean;
}

/** 顶部布局切换器的四个按钮：图标 + 中文名 + title 提示。 */
const LAYOUT_BUTTONS = [
  { key: 'list', icon: List, label: '列表' },
  { key: 'timeline', icon: CalendarClock, label: '时间轴' },
  { key: 'masonry', icon: Columns2, label: '瀑布流' },
  { key: 'source', icon: AppWindow, label: '按来源' },
] as const;

export function App() {
  const view = useClipStore((s) => s.view);
  const mode = useClipStore((s) => s.mode);
  const kind = useClipStore((s) => s.kind);
  const q = useClipStore((s) => s.q);
  const items = useClipStore((s) => s.items);
  const selectedIds = useClipStore((s) => s.selectedIds);
  const loading = useClipStore((s) => s.loading);
  const total = useClipStore((s) => s.total);
  const settings = useClipStore((s) => s.settings);
  const ghost = useClipStore((s) => s.ghost);
  const capabilities = useClipStore((s) => s.capabilities);
  const toasts = useClipStore((s) => s.toasts);
  const wordcloud = useClipStore((s) => s.wordcloud);
  const mergeHint = useClipStore((s) => s.mergeHint);
  const trashItems = useClipStore((s) => s.trashItems);
  const trashTotal = useClipStore((s) => s.trashTotal);
  const trashLoading = useClipStore((s) => s.trashLoading);
  /** 优化面板的原文初值：由卡片「优化」按钮写进来。 */
  const optimizeSource = useClipStore((s) => s.optimizeSource);

  /**
   * 片段库全表。
   * ★ 不进 store：片段只有这一个视图用得到，且四个动作（保存 / 删除 / 使用）
   *   都由主进程返回**整张表**，放本地 state 比在 store 里再开一份切片简单。
   */
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetsLoading, setSnippetsLoading] = useState(false);

  /** 更新检查状态；null = 还没点过（设置页据此显示「当前版本」而不是「已是最新」）。 */
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  // ★ 传整个 settings 当 refreshKey：设置页改完快捷键后要重新读一次注册结果，
  //   否则「已生效 / 注册失败」永远停在启动那一刻的答案。
  //   用对象而不是拼接字符串：updateSettings 先乐观 set 一次、落库后再 set 一次，
  //   只有后者那次读到的才是主进程重注册之后的真实状态。
  const hotkeys = useHotkeyStatus(settings);
  const autoStart = useAutoStart();

  /**
   * AI 模型列表：主进程是唯一事实来源（Key 只在那边存）。
   * 这里不放进 store —— 只有设置页用得到，也没必要跟着全局状态走。
   */
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);

  /** 右键菜单落点；null = 不显示。 */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 全文 / 大图浮层；null = 关闭。 */
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  /**
   * OCR 结果浮层：itemId 非空即打开。
   * 状态、进度、结果、错误分开存 —— 它们由四条不同的路径更新（打开 / 订阅 / 识别 / 下载），
   * 合成一个对象的话每次都要整体重建，容易出现"改了进度把结果清掉"这类错。
   */
  const [ocr, setOcr] = useState<{ itemId: string } | null>(null);
  const [ocrStatus, setOcrStatus] = useState<OcrStatus | null>(null);
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);

  /** 小组件形态下收起侧栏，把宽度让给内容（spec §6.6 切形态改布局）。 */
  const widgetCompact = mode === 'widget';

  // ★ 小组件按内容自适应高度（用户反馈「小组件有一大部分是空白」）：
  //   窗口高度跟着可见条数走，条数少就变矮，不再用固定 420 把列表撑出留白。
  useEffect(() => {
    if (!widgetCompact) return;
    const rows = Math.min(items.length, WIDGET_PREVIEW_COUNT);
    void getPlatform().app.setWidgetHeight(widgetWindowHeight(rows));
  }, [widgetCompact, items.length]);

  // 挂载：订阅主进程事件 + 首屏取数 + 幽灵倒计时。
  useEffect(() => {
    const unbind = bindClipStore();
    const store = useClipStore.getState();
    void store.load();
    void (async () => {
      try {
        const platform = getPlatform();
        const [nextSettings, nextGhost] = await Promise.all([
          platform.settings.get(),
          platform.ghost.get(),
        ]);
        useClipStore.setState({ settings: nextSettings, ghost: nextGhost });
        document.documentElement.setAttribute('data-theme', nextSettings.theme);
      } catch {
        // 非 Electron 环境（浏览器预览）用默认主题，不弹错。
      }
    })();
    const tick = setInterval(() => useClipStore.getState().tickGhost(), 1000);
    return () => {
      unbind();
      clearInterval(tick);
    };
  }, []);


  // AI 模型列表：读一次 + 订阅主进程的变更（新增/编辑/删除后刷新）。
  // 非 Electron 环境读不到就保持空列表，不打扰用户（照 store.ts 的订阅写法）。
  useEffect(() => {
    const platform = getPlatform();
    let alive = true;
    const refresh = () => {
      platform.ai
        .listProviders()
        .then((list) => {
          if (alive) setAiProviders(list);
        })
        .catch(() => {
          /* 没有实现（浏览器预览 / 手机端）就保持空列表 */
        });
    };
    refresh();
    const off = platform.ai.onChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  /**
   * 更新状态：只订阅，不主动检查。
   * ★ 启动时检查更新会打一次 GitHub 请求（未打包时还会在控制台刷错），
   *   所以主进程只在设置页手动点「检查更新」时才发请求，这里负责接结果。
   */
  useEffect(() => {
    const platform = getPlatform();
    const off = platform.app.onUpdate((s) => setUpdateStatus(s));
    return () => off();
  }, []);

  /**
   * 片段库：进视图时拉一次全表，并订阅主进程的变更（别的窗口/托盘改了也同步）。
   * ★ 只在视图打开期间订阅：片段表可能有几十条，没必要常驻一份。
   */
  useEffect(() => {
    if (view !== 'snippets') return;
    const platform = getPlatform();
    let alive = true;
    const refresh = () => {
      platform.snippets
        .list()
        .then((list) => {
          if (alive) setSnippets(list);
        })
        .catch(() => {
          // 非 Electron 环境没有实现：保持空表，页面显示空状态而不是报错。
        })
        .finally(() => {
          if (alive) setSnippetsLoading(false);
        });
    };
    setSnippetsLoading(true);
    refresh();
    // ★ onChanged 不带参数（主进程只说"变了"），所以订阅里再拉一次全表 ——
    //   与 ai.onChanged 同一套写法。
    const off = platform.snippets.onChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [view]);

  /**
   * 设置页要显示语言包状态，而它平时是 null（只有 OCR 面板会去问）。
   * ★ 进设置页时补一次：不问就永远停在「正在读取状态…」，而主进程的 status 只是
   *   看两个文件在不在（不起 worker），代价可以忽略。
   */
  useEffect(() => {
    if (view !== 'settings' || ocrStatus !== null) return;
    let alive = true;
    getPlatform()
      .ocr.status()
      .then((next) => {
        if (alive) setOcrStatus(next);
      })
      .catch(() => {
        // 非 Electron 环境 / preload 未加载：保持 null，设置页继续显示"正在读取状态…"。
      });
    return () => {
      alive = false;
    };
  }, [view, ocrStatus]);

  // OCR 进度：只在面板打开期间订阅（关掉就退订，否则主进程会一直往一个死面板推事件）。
  useEffect(() => {
    if (!ocr) return;
    const off = getPlatform().ocr.onProgress(setOcrProgress);
    return off;
  }, [ocr]);

  // 全局键盘（spec §7.7）。判定收在 ./keymap 的纯函数里，这里只把动作派发给 store：
  // 仓库没有 jsdom（vitest 只跑 node），判定逻辑必须能脱离 DOM 单测。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const store = useClipStore.getState();
      const target = event.target as HTMLElement | null;
      const inSearch = target?.dataset?.['ccSearch'] !== undefined;
      const action = resolveKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        },
        { inSearch, selectedIds: store.selectedIds },
      );
      if (action.type === 'none') return;
      if (shouldPreventDefault(action)) event.preventDefault();

      switch (action.type) {
        case 'hide':
          void hidePanel();
          return;
        case 'focus-search':
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case 'merge':
          void store.mergeSelected();
          return;
        case 'pin':
          void store.togglePin(action.id);
          return;
        case 'clear-unpinned':
          // 键盘路径也要二次确认（设置页是「再点一次」，这里改成 3 秒内再按一次）。
          store.pressClearUnpinned();
          return;
        case 'remove-selected':
          void store.removeSelected();
          return;
        case 'move':
          // 搜索框里按 ↑ / ↓：先跳出到列表再移动（spec §7.7：↓ 跳列表、↑ 回搜索框）。
          if (action.fromSearch) searchRef.current?.blur();
          store.moveSelection(action.delta);
          return;
        case 'paste':
          void store.pasteSelected();
          return;
        case 'paste-plain': {
          // 键盘路径与右键菜单同一个动作：只贴当前选中项，失败静默（主进程会自己 toast）。
          const id = store.selectedIds[0];
          if (id) void pastePlain(id);
          return;
        }
        case 'undo':
          void store.undoRemove();
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 连续复制提示条 5 秒后自动消失；只清提示，不动选中集（spec §7.5）。
  useEffect(() => {
    if (!mergeHint) return;
    const timer = setTimeout(() => useClipStore.getState().setMergeHint(null), MERGE_HINT_TTL_MS);
    return () => clearTimeout(timer);
  }, [mergeHint]);

  const paste = useCallback(async (id: string) => {
    const store = useClipStore.getState();
    store.select(id);
    try {
      const result = await getPlatform().items.paste(id);
      const { text, tone } = pasteToast(result);
      store.toast(text, tone);
    } catch (err) {
      store.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  const toggleMode = useCallback(() => {
    const next: AppMode = useClipStore.getState().mode === 'widget' ? 'main' : 'widget';
    void (async () => {
      try {
        await getPlatform().app.setMode(next);
      } catch {
        // 非 Electron 环境只切本地状态。
      }
      useClipStore.getState().setMode(next);
    })();
  }, []);

  /**
   * 卡片「优化」按钮：先取全文，取不到就不打开空面板（不假装成功）。
   * 通道报错时也要出声，不能让按钮点了毫无反应。
   */
  const openOptimize = useCallback(async (id: string) => {
    try {
      const text = await getPlatform().items.getText(id);
      if (text === '') {
        useClipStore.getState().toast('这条记录没有可优化的文本', 'warn');
        return;
      }
      useClipStore.getState().openOptimize(text);
    } catch {
      useClipStore.getState().toast('读取全文失败，请重试', 'warn');
    }
  }, []);

  /**
   * 只贴纯文本（丢掉原记录的富文本）：右键菜单与 Ctrl+Shift+V 共用。
   * 失败静默 —— 主进程已经处理了 toast，这里再弹一次会重复。
   */
  const pastePlain = useCallback(async (id: string) => {
    try {
      await getPlatform().items.pastePlain(id);
    } catch {
      // 浏览器预览 / 主进程未实现：忽略。
    }
  }, []);

  /**
   * 拖出到外部应用：主进程接管 startDrag，失败静默（拖拽本身已经是"尽力而为"的交互）。
   * ★ 这条链路是 ClipCard → ListPanel（含三种布局）→ 主进程 webContents.startDrag：
   *   ListBodyProps 少了 onDragStart 就会一路编译通过但拖不动，改的时候四处都要看。
   */
  const startDrag = useCallback(async (id: string) => {
    try {
      await getPlatform().items.startDrag(id);
    } catch {
      // 同上。
    }
  }, []);

  /** 只复制不粘贴（右键菜单 / 与双击粘贴区分开）：不刷新排序、不贴回前台窗口。 */
  const copyItem = useCallback(async (id: string) => {
    useClipStore.getState().select(id);
    try {
      const { text, tone } = copyToast(await getPlatform().items.copy(id));
      useClipStore.getState().toast(text, tone);
    } catch (err) {
      useClipStore.getState().toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  /**
   * 查看全文 / 大图：先开壳再取内容（取图是异步的，空壳比空白更可解释）。
   * 图片走协议 URL（主进程不出磁盘路径），文本走 items.getText 拿未截断的原文。
   */
  const openViewer = useCallback(async (id: string) => {
    const item = useClipStore.getState().items.find((it) => it.id === id);
    const kind = viewerKindOf(item);
    if (kind === 'none') return;
    const title = viewerTitleOf(item);
    if (kind === 'image') {
      setViewer({ id, kind, title, loading: true });
      try {
        const url = await getPlatform().items.getFullImage(id);
        setViewer((cur) => (cur && cur.id === id ? { ...cur, imageUrl: url, loading: false } : cur));
      } catch {
        setViewer((cur) => (cur && cur.id === id ? { ...cur, loading: false } : cur));
      }
      return;
    }
    setViewer({ id, kind, title, loading: true });
    try {
      const text = await getPlatform().items.getText(id);
      setViewer((cur) =>
        cur && cur.id === id
          ? { ...cur, text: text === '' ? (item?.preview ?? '') : text, loading: false }
          : cur,
      );
    } catch {
      // 取全文失败就退回卡片上已有的预览，不让用户面对一个空壳。
      setViewer((cur) => (cur && cur.id === id ? { ...cur, text: item?.preview ?? '', loading: false } : cur));
    }
  }, []);

  /**
   * 识别当前这一条。
   * ★ 失败原因翻成中文后放进 error（面板红字），loading 由 finally 收掉 ——
   *   否则识别一失败按钮就永远停在「识别中…」。
   */
  const recognizeOcr = useCallback(async (itemId: string) => {
    setOcrLoading(true);
    setOcrError(null);
    try {
      setOcrResult(await getPlatform().ocr.recognize(itemId));
    } catch (err) {
      setOcrError(ocrErrorText(err));
    } finally {
      setOcrLoading(false);
      // ★ 收尾必须清进度：设置页只要 progress 非 null 就会显示「正在识别…」，
      //   不清的话识别完那条文案会一直挂在那里。
      setOcrProgress(null);
    }
  }, []);

  /**
   * 右键「识别文字」：开面板 + 问一次状态，就绪才自动识别。
   * ★ 未就绪时不调 recognize：那只会拿到一句「尚未下载文字识别语言包」，
   *   不如让面板直接把下载按钮摆出来（OcrResultView 按 status.ready 分支渲染）。
   * ★ 不做「是不是图片」判断：menuItemsFor 已经只在图片记录上给 ocr。
   */
  const openOcr = useCallback(
    async (id: string) => {
      setOcr({ itemId: id });
      setOcrResult(null);
      setOcrError(null);
      setOcrProgress(null);
      setOcrLoading(true);
      try {
        const status = await getPlatform().ocr.status();
        setOcrStatus(status);
        if (!status.ready) return;
        setOcrResult(await getPlatform().ocr.recognize(id));
      } catch (err) {
        setOcrError(ocrErrorText(err));
      } finally {
        setOcrLoading(false);
        setOcrProgress(null);
      }
    },
    [],
  );

  const menuItems = useCallback((id: string) => {
    const item = useClipStore.getState().items.find((it) => it.id === id);
    if (!item) return [];
    return menuItemsFor({
      kind: item.kind,
      pinned: item.pinned,
      truncated: item.truncated,
      // 文本记录一律给「查看全文」：列表预览固定截到 200 字，库里最多 10 万字。
      hasFullText: item.kind !== 'image',
    });
  }, []);

  const pickMenu = useCallback(
    (action: MenuAction, id: string) => {
      setMenu(null);
      switch (action) {
        case 'copy':
          void copyItem(id);
          return;
        case 'paste':
          void paste(id);
          return;
        case 'paste-plain':
          void pastePlain(id);
          return;
        case 'view':
          void openViewer(id);
          return;
        case 'ocr':
          void openOcr(id);
          return;
        case 'optimize':
          void openOptimize(id);
          return;
        case 'pin':
          void useClipStore.getState().togglePin(id);
          return;
        case 'remove':
          void useClipStore.getState().remove(id);
          return;
      }
    },
    [copyItem, openOcr, openOptimize, openViewer, paste, pastePlain],
  );

  // 优化面板的平台动作：组件不碰 getPlatform，一律由 App 注入（与设置页一致）。
  const loadScenes = useCallback(() => getPlatform().ai.scenes(), []);
  const runOptimize = useCallback((req: OptimizeRequest) => getPlatform().ai.optimize(req), []);
  const copyAndPaste = useCallback((text: string) => getPlatform().ai.copyAndPaste(text), []);
  /** 「复制」只写剪贴板（不贴回），与「直接粘贴」是两条路径。 */
  const writeClipboard = useCallback((text: string) => getPlatform().clipboard.writeText(text), []);
  /**
   * 流式增量订阅：取消函数原样交给面板（面板的 useEffect 返回它，
   * 切换视图卸载面板时就地清理），App 不额外持有订阅句柄。
   */
  const subscribeOptimizeDelta = useCallback(
    (cb: (delta: OptimizeDelta) => void) => getPlatform().ai.onOptimizeDelta(cb),
    [],
  );
  // 优化历史的读写都在主进程（写入口在 ai.optimize 成功之后），这里只转发。
  const loadHistory = useCallback(() => getPlatform().ai.history(), []);
  const removeHistory = useCallback((id: string) => getPlatform().ai.historyRemove(id), []);
  const clearHistory = useCallback(() => getPlatform().ai.historyClear(), []);
  const toast = useCallback((text: string, tone?: ToastTone) => useClipStore.getState().toast(text, tone), []);

  /**
   * 检查更新 / 重启安装。
   * ★ 状态不在这里存 —— 主进程推 EV.updateStatus，上面那个订阅统一 setUpdateStatus，
   *   所以这里只发请求、不做乐观更新（否则会和推送来的真实状态打架）。
   *   失败也不 toast：设置页那一行会把 error 文案显示出来。
   */
  const checkUpdate = useCallback(async () => {
    try {
      setUpdateStatus(await getPlatform().app.checkUpdate());
    } catch {
      setUpdateStatus({ state: 'error', message: '检查更新失败，请稍后重试' });
    }
  }, []);
  const applyUpdate = useCallback(async () => {
    try {
      await getPlatform().app.applyUpdate();
    } catch {
      useClipStore.getState().toast('重启安装失败，请手动退出后重开', 'warn');
    }
  }, []);

  // OCR 面板的平台动作：组件不碰 getPlatform，全部由 App 注入（与优化面板一致）。
  /**
   * 下载语言包：成功且已就绪就顺手把当前这条识别掉 —— 用户点下载的意图就是"我要看字"。
   * 下载可能几十秒，loading 全程为 true（OcrResultView 据此显示进度条而不是空面板）。
   */
  const downloadOcr = useCallback(async () => {
    const current = ocr;
    setOcrLoading(true);
    setOcrError(null);
    try {
      const status = await getPlatform().ocr.download();
      setOcrStatus(status);
      if (!status.ready) {
        // 下载失败的原因已经在 status.error 里（ocrStatusText 会优先显示它）。
        return;
      }
      if (current) setOcrResult(await getPlatform().ocr.recognize(current.itemId));
    } catch (err) {
      setOcrError(ocrErrorText(err));
    } finally {
      setOcrLoading(false);
      setOcrProgress(null);
    }
  }, [ocr]);

  const recognizeCurrentOcr = useCallback(() => {
    if (ocr) void recognizeOcr(ocr.itemId);
  }, [ocr, recognizeOcr]);

  /**
   * 存为一条新记录。
   * ★ 不手动 reload：主进程 items:saveText 写库后会自己发 itemsChanged，列表会刷新；
   *   这里再刷一次只会白跑一遍查询。
   */
  const saveOcrAsItem = useCallback(
    async (text: string) => {
      try {
        const result = await getPlatform().items.saveText(text);
        const { text: message, tone } = result.ok ? ocrSavedToast() : { text: '存为记录失败，请重试', tone: 'warn' as const };
        toast(message, tone);
      } catch (err) {
        toast(ocrErrorText(err), 'error');
      }
    },
    [toast],
  );

  const closeOcr = useCallback(() => {
    setOcr(null);
    setOcrStatus(null);
    setOcrProgress(null);
    setOcrResult(null);
    setOcrError(null);
    setOcrLoading(false);
  }, []);

  /**
   * 片段库的四个动作：主进程一律返回整张表，直接替换本地 state 即可（不再多拉一次）。
   * ★ 失败要出声：片段是用户亲手存的东西，"点了保存没反应"比报错难受得多。
   */
  const createSnippet = useCallback(async (input: SnippetInput) => {
    try {
      setSnippets(await getPlatform().snippets.save(input));
    } catch (err) {
      useClipStore.getState().toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  const updateSnippet = useCallback(async (input: SnippetInput) => {
    try {
      setSnippets(await getPlatform().snippets.save(input));
    } catch (err) {
      useClipStore.getState().toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  const removeSnippet = useCallback(async (id: string) => {
    try {
      setSnippets(await getPlatform().snippets.remove(id));
    } catch (err) {
      useClipStore.getState().toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  const useSnippet = useCallback(async (id: string) => {
    try {
      setSnippets(await getPlatform().snippets.use(id));
    } catch (err) {
      useClipStore.getState().toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  /**
   * 批量操作（P2-8）：三个动作做完都要刷新列表并清空选择。
   * 选择清空的时机不同：删除必须清（那些行已经没了），粘贴/收藏成功后也清
   * —— 操作栏留在屏幕上会让人以为还能再点一次同一批。
   */
  const batchPaste = useCallback(async () => {
    const store = useClipStore.getState();
    const ids = store.selectedIds;
    if (ids.length === 0) return;
    try {
      const { text, tone } = pasteToast(await getPlatform().items.pasteMany(ids));
      store.toast(text, tone);
    } catch (err) {
      store.toast(err instanceof Error ? err.message : String(err), 'error');
    }
    store.select(null);
    await store.load();
  }, []);

  const batchPin = useCallback(async (pinned: boolean) => {
    const store = useClipStore.getState();
    const ids = store.selectedIds;
    if (ids.length === 0) return;
    try {
      await getPlatform().items.pinMany(ids, pinned);
    } catch (err) {
      store.toast(err instanceof Error ? err.message : String(err), 'error');
    }
    store.select(null);
    await store.load();
  }, []);

  const batchRemove = useCallback(async () => {
    const store = useClipStore.getState();
    const ids = store.selectedIds;
    if (!canBatchRemove(ids.length)) return;
    try {
      await getPlatform().items.removeMany(ids);
    } catch (err) {
      store.toast(err instanceof Error ? err.message : String(err), 'error');
    }
    // 删除后选择必须清空：ids 里那些行已经不在列表里了。
    store.select(null);
    await store.load();
  }, []);

  const openWordCloud = useCallback(() => {
    useClipStore.getState().setView('wordcloud');
    void useClipStore.getState().loadWordCloud();
  }, []);

  const onHide = useCallback(() => void hidePanel(), []);
  const setGhost = useCallback((minutes: number) => void useClipStore.getState().setGhost(minutes), []);
  const clearUnpinned = useCallback(() => void useClipStore.getState().clearUnpinned(), []);
  const clearAll = useCallback(() => void useClipStore.getState().clearAll(), []);
  const setAutoStart = useCallback(
    (on: boolean) => useClipStore.getState().setAutoStart(on),
    [],
  );
  const openDataFolder = useCallback(() => void useClipStore.getState().openDataFolder(), []);
  const updateSettings = useCallback(
    (patch: Partial<Settings>) => void useClipStore.getState().updateSettings(patch),
    [],
  );

  // 设置页「AI 模型」区的四个动作：全部走主进程，渲染层只拿掩码（Review Focus 6）。
  // 失败一律往上抛（由表单显示中文错误），不在这里吞掉。
  const saveAiProvider = useCallback(async (input: AiProviderInput) => {
    const next = await getPlatform().ai.saveProvider(input);
    setAiProviders(next);
  }, []);

  const removeAiProvider = useCallback(async (id: string) => {
    const next = await getPlatform().ai.removeProvider(id);
    setAiProviders(next);
  }, []);

  const testAiProvider = useCallback(
    (id: string): Promise<{ ok: boolean; error?: AiError; model?: string }> =>
      getPlatform().ai.test(id),
    [],
  );

  const listAiModels = useCallback((id: string): Promise<string[]> => getPlatform().ai.listModels(id), []);

  /**
   * 批量操作栏的输入。
   * ★ 只看**已加载**的选中项：选中集里可能还留着上一页的 id（换分类时 store 会过滤，
   *   但翻页期间不会），拿不到的项当"未收藏"处理 —— 宁可显示「收藏」也不要显示
   *   一个会对空集合执行的「取消收藏」。
   */
  const selectedItems = items.filter((it) => selectedIds.includes(it.id));
  const batchAllPinned = selectedItems.length > 0 && selectedItems.every((it) => it.pinned);

  const glassClass = capabilities.frostedGlass ? 'cc-shell--glass' : 'cc-shell--glass-fallback';

  return (
    <div className={cn('cc-shell relative rounded-card', glassClass)}>
      <TitleBar
        view={view}
        mode={mode}
        ghostActive={ghost.active}
        ghostRemainingMs={ghost.remainingMs}
        onBack={() => useClipStore.getState().setView('list')}
        onHide={onHide}
        onClose={onHide}
      />

      {widgetCompact ? (
        <WidgetView
          items={items}
          q={q}
          selectedIds={selectedIds}
          onSelect={(id) => useClipStore.getState().select(id)}
          onPaste={(id) => void paste(id)}
          onTogglePin={(id) => void useClipStore.getState().togglePin(id)}
          onSearch={(next) => useClipStore.getState().setQuery(next)}
          onShowAll={toggleMode}
        />
      ) : null}

      {/*
        ★ 小组件形态下这一层必须真正 display:none（而不是只隐藏子列）。
           否则它作为 flex-1 兄弟仍会分走一半高度，WidgetView 只能占上半，
           下半留出一大片空白 —— 用户报的「小组件有一大部分是空白」就是这个。
      */}
      <div className={cn('flex min-h-0 flex-1', widgetCompact && 'hidden')}>
        {!widgetCompact ? (
          <Sidebar
            kind={kind}
            view={view}
            onSelectKind={(next) => {
              useClipStore.getState().setView('list');
              useClipStore.getState().setKind(next);
            }}
            onOpenTrash={() => void useClipStore.getState().openTrash()}
            onOpenSettings={() => useClipStore.getState().setView('settings')}
            onOpenOptimize={() => useClipStore.getState().openOptimize('')}
            onOpenSnippets={() => useClipStore.getState().openSnippets()}
          />
        ) : null}

        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', widgetCompact && 'hidden')}>
          {view === 'list' ? (
            <>
              <div className="flex shrink-0 items-center gap-tight px-base py-snug">
                <SearchBar
                  ref={searchRef}
                  value={q}
                  onChange={(next) => useClipStore.getState().setQuery(next)}
                  onArrowDown={() => {
                    const first = useClipStore.getState().items[0];
                    if (first) useClipStore.getState().select(first.id);
                  }}
                  onEscape={onHide}
                  className="flex-1"
                />
                {LAYOUT_BUTTONS.map(({ key, icon: Icon, label }) => (
                  <button
                    key={key}
                    type="button"
                    title={'布局：' + label}
                    onClick={() => void useClipStore.getState().updateSettings({ listLayout: key })}
                    className={cn(
                      'cc-no-drag flex shrink-0 items-center rounded-button border px-[6px] py-[7px] transition-colors',
                      settings.listLayout === key
                        ? 'border-[var(--cc-primary)] bg-primary-soft text-[var(--cc-primary)]'
                        : 'border-line text-ink-2 hover:bg-surface-2',
                    )}
                  >
                    <Icon size={12} aria-hidden />
                  </button>
                ))}
                <button
                  type="button"
                  title="今日词云"
                  onClick={openWordCloud}
                  className="cc-no-drag flex shrink-0 items-center gap-[4px] rounded-button border border-line px-snug py-[7px] text-[11px] text-ink-2 hover:bg-surface-2"
                >
                  <Sparkles size={12} aria-hidden />
                  词云
                </button>
                <button
                  type="button"
                  title="切换小组件形态"
                  onClick={toggleMode}
                  className="cc-no-drag flex shrink-0 items-center gap-[4px] rounded-button border border-line px-snug py-[7px] text-[11px] text-ink-2 hover:bg-surface-2"
                >
                  {mode === 'widget' ? <List size={12} aria-hidden /> : <LayoutGrid size={12} aria-hidden />}
                  小组件
                </button>
              </div>

              {mergeHint ? (
                <div className="cc-no-drag mx-base mb-snug flex shrink-0 items-center gap-tight rounded-button border border-line bg-surface-2 px-snug py-[6px] text-[11px] text-ink-2">
                  <Sparkles size={12} aria-hidden />
                  <span>连续复制了 {mergeHint.count} 条，按 Ctrl+M 拼接</span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => useClipStore.getState().setMergeHint(null)}
                    className="rounded-button px-[6px] py-[1px] hover:bg-surface hover:text-ink"
                  >
                    知道了
                  </button>
                </div>
              ) : null}

              {/*
                批量操作栏（P2-8）：选中集非空时出现。
                ★ 按钮集合由 batchBar 的纯函数决定（能单测），这里只负责派发。
              */}
              {selectedIds.length > 0 ? (
                <div className="cc-no-drag mx-base mb-snug flex shrink-0 items-center gap-tight rounded-button border border-line bg-surface-2 px-snug py-[6px] text-[11px] text-ink-2">
                  <span>{batchBarText(selectedIds.length)}</span>
                  <div className="flex-1" />
                  {batchActions(selectedIds.length, batchAllPinned).map((action) => (
                    <button
                      key={action.key}
                      type="button"
                      disabled={action.key === 'remove' && !canBatchRemove(selectedIds.length)}
                      onClick={() => {
                        if (action.key === 'paste') void batchPaste();
                        else if (action.key === 'pin') void batchPin(true);
                        else if (action.key === 'unpin') void batchPin(false);
                        else void batchRemove();
                      }}
                      className={cn(
                        'shrink-0 rounded-button border px-snug py-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                        action.danger
                          ? 'border-line text-ink-2 hover:bg-surface hover:text-[var(--cc-accent)]'
                          : 'border-line text-ink-2 hover:bg-surface hover:text-ink',
                      )}
                    >
                      {action.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => useClipStore.getState().select(null)}
                    className="shrink-0 rounded-button px-[6px] py-[3px] text-ink-3 hover:bg-surface hover:text-ink"
                  >
                    取消选择
                  </button>
                </div>
              ) : null}

              <ListPanel
                items={items}
                kind={kind}
                q={q}
                selectedIds={selectedIds}
                loading={loading}
                onSelect={(id, opts) => useClipStore.getState().select(id, opts)}
                onPaste={(id) => void paste(id)}
                onTogglePin={(id) => void useClipStore.getState().togglePin(id)}
                onOptimize={(id) => void openOptimize(id)}
                onLoadMore={() => void useClipStore.getState().loadMore()}
                onContextMenu={(id, x, y) => setMenu({ id, x, y })}
                onDragStart={(id) => void startDrag(id)}
                layout={settings.listLayout}
              />

              <div className="flex shrink-0 items-center gap-tight border-t border-line px-base py-[6px] text-[11px] text-ink-3">
                {/* 真实总数（不是已加载条数）：列表分页 200 条一页，用 items.length 会少报。 */}
                <span>共 {total} 条</span>
                <span>·</span>
                <span>单击选中 · 双击粘贴 · 右键更多</span>
                <div className="flex-1" />
                <button
                  type="button"
                  title="设置"
                  onClick={() => useClipStore.getState().setView('settings')}
                  className="flex items-center gap-[4px] rounded-button px-tight py-[2px] hover:bg-surface-2 hover:text-ink-2"
                >
                  <Settings2 size={12} aria-hidden />
                  设置
                </button>
              </div>
            </>
          ) : null}

          {view === 'settings' ? (
            <SettingsView
              settings={settings}
              ghost={ghost}
              capabilities={capabilities}
              hotkeys={hotkeys}
              autoStart={autoStart}
              mode={mode}
              onUpdate={updateSettings}
              onGhost={setGhost}
              onClearUnpinned={clearUnpinned}
              onClearAll={clearAll}
              onOpenDataFolder={openDataFolder}
              onExportAll={() => void useClipStore.getState().exportAll()}
              onImportAll={() => void useClipStore.getState().importAll()}
              onSetAutoStart={setAutoStart}
              onToggleMode={toggleMode}
              aiProviders={aiProviders}
              onAiSave={saveAiProvider}
              onAiRemove={removeAiProvider}
              onAiTest={testAiProvider}
              onAiListModels={listAiModels}
              ocrStatus={ocrStatus}
              ocrProgress={ocrProgress}
              onOcrDownload={() => void downloadOcr()}
              updateStatus={updateStatus}
              onCheckUpdate={() => void checkUpdate()}
              onApplyUpdate={() => void applyUpdate()}
            />
          ) : null}

          {view === 'optimize' ? (
            <OptimizeView
              source={optimizeSource}
              providers={aiProviders}
              onScenes={loadScenes}
              onOptimize={runOptimize}
              onCopyAndPaste={copyAndPaste}
              onCopyToClipboard={writeClipboard}
              onOptimizeDelta={subscribeOptimizeDelta}
              onToast={toast}
              onCancel={(requestId) => void getPlatform().ai.cancel(requestId)}
              onGoSettings={() => useClipStore.getState().setView('settings')}
              onHistory={loadHistory}
              onHistoryRemove={removeHistory}
              onHistoryClear={clearHistory}
            />
          ) : null}

          {view === 'trash' ? (
            <TrashView
              items={trashItems}
              total={trashTotal}
              loading={trashLoading}
              onLoadMore={() => void useClipStore.getState().loadMoreTrash()}
              onRestore={(id) => void useClipStore.getState().restoreFromTrash(id)}
              onPurge={(id) => void useClipStore.getState().purgeFromTrash(id)}
              onEmptyTrash={() => void useClipStore.getState().emptyTrash()}
            />
          ) : null}

          {view === 'snippets' ? (
            <SnippetView
              snippets={snippets}
              loading={snippetsLoading}
              onCreate={(input) => void createSnippet(input)}
              onUpdate={(input) => void updateSnippet(input)}
              onRemove={(id) => void removeSnippet(id)}
              onUse={(id) => void useSnippet(id)}
            />
          ) : null}

          {view === 'wordcloud' ? (
            <WordCloudView
              data={wordcloud}
              loading={loading}
              onExport={() => void useClipStore.getState().exportWordCloud()}
              onRefresh={() => void useClipStore.getState().loadWordCloud()}
            />
          ) : null}
        </div>
      </div>

      <ResizeHandles
        mode={mode}
        onResizeBy={(dw, dh, shape) => void getPlatform().app.resizeBy(dw, dh, shape)}
        onWidgetWidth={(px) => void useClipStore.getState().setWidgetSize(px)}
      />

      {/* 右键菜单与查看器都渲染在最后：它们要盖住所有视图（含小组件形态）。 */}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.id)}
          onPick={(action) => pickMenu(action, menu.id)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <TextViewer
        open={viewer !== null}
        title={viewer?.title ?? ''}
        text={viewer?.text}
        imageUrl={viewer?.imageUrl}
        loading={viewer?.loading}
        onCopy={(text) => void writeClipboard(text).then(() => toast('已复制到剪贴板', 'ok'))}
        onClose={() => setViewer(null)}
      />

      {/* 与 TextViewer 同层：都要盖住所有视图（含小组件形态）。 */}
      <OcrResultView
        open={ocr !== null}
        itemId={ocr?.itemId ?? ''}
        status={ocrStatus}
        progress={ocrProgress}
        result={ocrResult}
        error={ocrError}
        loading={ocrLoading}
        onDownload={() => void downloadOcr()}
        onRecognize={recognizeCurrentOcr}
        onSaveAsItem={(text) => void saveOcrAsItem(text)}
        onCopy={(text) => void writeClipboard(text).then(() => toast('已复制到剪贴板', 'ok'))}
        onClose={closeOcr}
      />

      <ToastStack toasts={toasts} onDismiss={(id) => useClipStore.getState().dismissToast(id)} />
    </div>
  );
}

/** Esc / 关闭按钮：让主进程把面板藏进托盘；非 Electron 环境静默忽略。 */
async function hidePanel(): Promise<void> {
  try {
    await getPlatform().app.hide();
  } catch {
    // 浏览器预览里没有托盘，忽略。
  }
}

export type { View };
