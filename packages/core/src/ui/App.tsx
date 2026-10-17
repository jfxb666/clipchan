import { useCallback, useEffect, useRef } from 'react';
import { LayoutGrid, List, Settings2, Sparkles } from 'lucide-react';
import type { Settings } from '../types';
import { getPlatform } from '../platform/adapter';
import { bindClipStore, useClipStore, type AppMode, type View } from '../state/store';
import { ListPanel } from './ListPanel';
import { ResizeHandles } from './ResizeHandles';
import { SearchBar } from './SearchBar';
import { SettingsView } from './SettingsView';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { ToastStack } from './Toast';
import { pasteToast } from './toastText';
import { WidgetView, WIDGET_PREVIEW_COUNT } from './WidgetView';
import { widgetWindowHeight } from './widgetFit';
import { WordCloudView } from './WordCloudView';
import { resolveKey, shouldPreventDefault } from './keymap';
import { useAutoStart, useHotkeyStatus } from './usePlatformValue';
import { cn } from './util';

/**
 * 应用外壳（spec §6.3）：主面板 900×620，自定义标题栏 + 64px 侧栏 + 搜索栏 + 卡片列表。
 *
 * 键盘（spec §7.7）：↑/↓ 移动、Enter 粘贴、Esc 隐藏面板、Ctrl+D 收藏、
 * Ctrl+M 拼接、Delete 删除、Ctrl+Delete 清空未收藏、Ctrl+F 聚焦搜索框。
 */
/** 连续复制提示条的存活时间（spec §7.5：5 秒后淡出，选中保持不动）。 */
const MERGE_HINT_TTL_MS = 5000;

export function App() {
  const view = useClipStore((s) => s.view);
  const mode = useClipStore((s) => s.mode);
  const kind = useClipStore((s) => s.kind);
  const q = useClipStore((s) => s.q);
  const items = useClipStore((s) => s.items);
  const selectedIds = useClipStore((s) => s.selectedIds);
  const loading = useClipStore((s) => s.loading);
  const settings = useClipStore((s) => s.settings);
  const ghost = useClipStore((s) => s.ghost);
  const capabilities = useClipStore((s) => s.capabilities);
  const toasts = useClipStore((s) => s.toasts);
  const wordcloud = useClipStore((s) => s.wordcloud);
  const mergeHint = useClipStore((s) => s.mergeHint);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const hotkeys = useHotkeyStatus();
  const autoStart = useAutoStart();

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
          void store.clearUnpinned();
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
            onOpenSettings={() => useClipStore.getState().setView('settings')}
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

              <ListPanel
                items={items}
                kind={kind}
                q={q}
                selectedIds={selectedIds}
                loading={loading}
                onSelect={(id, opts) => useClipStore.getState().select(id, opts)}
                onPaste={(id) => void paste(id)}
                onTogglePin={(id) => void useClipStore.getState().togglePin(id)}
                onLoadMore={() => void useClipStore.getState().loadMore()}
              />

              <div className="flex shrink-0 items-center gap-tight border-t border-line px-base py-[6px] text-[11px] text-ink-3">
                <span>共 {items.length} 条</span>
                <span>·</span>
                <span>单击选中 · 双击粘贴</span>
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
              onSetAutoStart={setAutoStart}
              onToggleMode={toggleMode}
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
