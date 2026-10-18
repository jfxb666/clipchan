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
export { OptimizeView, type OptimizeScene, type OptimizeViewProps } from './OptimizeViewCard';
export { OPTIMIZE_MODES, degradedHint, type OptimizeMode } from './optimizeView';
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
export { Toast, ToastStack, type ToastItem } from './Toast';
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
  clampMenuPosition,
  menuItemsFor,
  type MenuAction,
  type MenuItem,
  type MenuSource,
} from './contextMenu';
export { ContextMenu, type ContextMenuProps } from './ContextMenuView';
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
