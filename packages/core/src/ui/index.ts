/**
 * 界面层的唯一出口（package.json 的 "./ui" 指向这里）。
 * 桌面端只需 `import { App } from '@clipchan/core/ui'`，
 * 组件内部依赖（store / platform）由 core 自己解析，宿主不必关心。
 */
export { App } from './App';
export { TitleBar } from './TitleBar';
export { Sidebar, NAV_ITEMS, type NavItem } from './Sidebar';
export { SearchBar } from './SearchBar';
export { ClipCard } from './ClipCard';
export { ListPanel, LOAD_MORE_THRESHOLD_PX } from './ListPanel';
export { type ListBodyProps } from './listBody';
export { TimelineList } from './TimelineList';
export { MasonryList } from './MasonryList';
export { SourceGroupList } from './SourceGroupList';
export {
  MASONRY_CARD_CHROME_PX,
  MASONRY_FALLBACK_IMAGE_HEIGHT,
  MASONRY_MAX_COLUMNS,
  MASONRY_MIN_COLUMN_PX,
  MASONRY_TEXT_CHARS_PER_LINE,
  MASONRY_TEXT_LINE_PX,
  MASONRY_TEXT_MAX_LINES,
  columnCountOf,
  distributeColumns,
  estimateCardHeight,
} from './masonry';
export { dayKeyOf, dayLabelOf, groupByDay, type TimelineGroup } from './timeline';
export {
  UNKNOWN_SOURCE_LABEL,
  groupBySource,
  sourceLabel,
  type SourceGroup,
} from './sourceGroups';
export { TrashView, type TrashViewProps } from './TrashView';
export {
  TRASH_PAGE_SIZE,
  TRASH_MAX_LIMIT,
  EMPTY_TRASH_CONFIRM_TTL_MS,
  EMPTY_TRASH_HINT,
  deletedAtText,
  emptyTrashLabel,
  isTrashEmpty,
  nextTrashOffset,
  purgeLabel,
  shouldShowEmptyTrash,
  trashTitle,
} from './trashViewLogic';
export { SnippetView, type SnippetViewProps } from './SnippetViewCard';
export {
  SNIPPET_CONFIRM_TTL_MS,
  SNIPPET_CONTENT_MAX,
  SNIPPET_TITLE_MAX,
  emptySnippetHint,
  snippetLabel,
  snippetMeta,
  snippetPreview,
  sortSnippets,
  validateSnippet,
} from './snippetView';
export { batchActions, batchBarText, canBatchRemove, type BatchAction } from './batchBar';
export {
  EXCLUDE_APPS_MAX,
  addExcludeApp,
  excludeAppsHint,
  normalizeAppEntry,
  removeExcludeApp,
  suggestExcludeApps,
} from './excludeApps';
export { canClickUpdate, updateButtonLabel, updateStatusText } from './updateView';
export { OptimizeView, type OptimizeScene, type OptimizeViewProps } from './OptimizeViewCard';
export { OPTIMIZE_MODES, degradedHint, type OptimizeMode } from './optimizeView';
export {
  HISTORY_LIMIT,
  emptyHistoryHint,
  historySceneLabel,
  historyTimeLabel,
  truncateForList,
} from './optimizeHistory';
// 历史条目类型定义在 types.ts（主进程与渲染层共用），这里顺手从 UI 出口再暴露一次，
// 免得调用方为了一个类型去深挖 core 的内部路径。
export type { OptimizeHistoryEntry } from '../types';
export { WidgetView, WIDGET_PREVIEW_COUNT, visibleWidgetItems } from './WidgetView';
export {
  WIDGET_AUTO_MAX_HEIGHT,
  WIDGET_AUTO_MIN_HEIGHT,
  WIDGET_CHROME_HEIGHT,
  WIDGET_ROW_HEIGHT,
  WIDGET_ROW_PITCH,
  widgetWindowHeight,
} from './widgetFit';
export {
  ResizeHandles,
  clampWidgetWidth,
  MAIN_MAX_HEIGHT,
  MAIN_MAX_WIDTH,
  MAIN_MIN_HEIGHT,
  MAIN_MIN_WIDTH,
  WIDGET_MAX_WIDTH,
  WIDGET_MIN_WIDTH,
  type ResizeHandleKind,
} from './ResizeHandles';
export { TypeBadge } from './TypeBadge';
export { EmptyState } from './EmptyState';
export { ErrorBoundary, type ErrorBoundaryProps } from './ErrorBoundary';
export { crashReportText, describeError, type CrashReportContext } from './errorBoundaryLogic';
export { firstRunTips, shouldShowFirstRun, type FirstRunTip } from './firstRun';
export { Toast, ToastStack, type ToastItem } from './Toast';
export { UNDO_LABEL, removeToast, undoToast } from './toastText';
export { WordCloudView } from './WordCloudView';
export {
  SettingsView,
  APP_VERSION,
  GHOST_MAX_MINUTES,
  GHOST_PRESETS,
  HISTORY_INPUT_MAX,
  HISTORY_SLIDER_MAX,
  HISTORY_SLIDER_MIN,
  HISTORY_SLIDER_STEP,
  IMAGE_BUDGET_OPTIONS,
  TRASH_LIMIT_MAX,
  TRASH_LIMIT_MIN,
  TRASH_LIMIT_OPTIONS,
  WIDGET_SIZE_MAX,
  WIDGET_SIZE_MIN,
} from './SettingsView';
export {
  AiProviderForm,
  LIST_FAILED_HINT,
  type AiProviderFormProps,
} from './AiProviderFormCard';
export {
  DEFAULT_BASE_URL,
  PROTOCOL_OPTIONS,
  aiErrorMessage,
  protocolLabel,
  validateProvider,
} from './aiProviderForm';
export { badgeOf, filterKindOf, emptyHintOf, type Badge, type BadgeIcon } from './badges';
export { highlightSegments, type HighlightSegment } from './highlight';
export {
  HIGHLIGHT_MAX_CHARS,
  HLJS_LANGUAGES,
  guessLanguage,
  shouldHighlight,
  highlightToHtml,
} from './codeHighlight';
export {
  clampMenuPosition,
  menuItemsFor,
  type MenuAction,
  type MenuItem,
  type MenuSource,
} from './contextMenu';
export { ContextMenu, type ContextMenuProps } from './ContextMenuView';
export { OcrResultView, type OcrResultViewProps } from './OcrResultView';
export {
  OCR_EMPTY_TOAST,
  OCR_SAVED_TOAST,
  canSaveAsItem,
  ocrEmptyToast,
  ocrErrorText,
  ocrProgressText,
  ocrSavedToast,
  ocrStatusText,
} from './ocrView';
export { viewerKindOf, viewerTitleOf, type ViewerKind, type ViewerSource } from './viewer';
export { TextViewer } from './TextViewer';
export {
  acceleratorLabel,
  isValidAccelerator,
  keyEventToAccelerator,
  type HotkeyKeyEvent,
} from './settingsHotkey';
export { HotkeyRecorder } from './HotkeyRecorder';
export {
  GHOST_RESUME_TOAST,
  GHOST_SKIP_TOAST,
  ghostOnToast,
  mergeToast,
  copyToast,
  pasteToast,
  type ToastAction,
  type ToastTone,
} from './toastText';
export {
  cn,
  formatClock,
  formatRemaining,
  formatTime,
  sizeLabelToMB,
} from './util';
export { useAutoStart, useHotkeyStatus, usePlatformValue } from './usePlatformValue';
export { APP_ICON_URL } from './assets';
export {
  applyStoredTheme,
  useClipStore,
  PAGE_SIZE,
  QUERY_DEBOUNCE_MS,
  TOAST_TTL_MS,
  type AppMode,
  type ClipStore,
  type ClipStoreActions,
  type ClipStoreState,
  type MergeHint,
  type View,
} from '../state/store';
