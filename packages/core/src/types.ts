/**
 * 跨平台共享的类型契约。这里的所有类型都必须能同时在 Electron 主进程、
 * 渲染进程与移动端里使用，因此**不得** import 任何 electron / node 模块。
 */

/** 一条剪贴板记录的内容类别。 */
export type Kind = 'text' | 'link' | 'code' | 'path' | 'number' | 'image';

/** 侧栏与筛选条能表达的查询类别（比 Kind 多出聚合与收藏）。 */
export type KindFilter = Kind | 'all' | 'favorite' | 'text-group';

/** 列表查询参数。排序与分页一律在 SQL 里完成，渲染进程不再二次过滤。 */
export interface ListQuery {
  kind?: KindFilter;
  /** 搜索词。文本匹配 content，图片匹配现场拼出的尺寸/体积描述。 */
  q?: string;
  limit?: number;
  offset?: number;
}

/** 给界面看的记录投影：原图磁盘路径与哈希不出主进程。 */
export interface ClipItemDTO {
  id: string;
  kind: Kind;
  preview: string;
  thumbUrl?: string;
  createdAt: number;
  pinned: boolean;
  truncated?: boolean;
  sizeLabel?: string;
  source: 'capture' | 'merge';
}

export type ThemeMode = 'auto' | 'light' | 'dark';

export interface Settings {
  theme: ThemeMode;
  historyLimit: number;
  imageBudgetMB: number;
  widgetSize: number;
  widgetCorner: 'remember' | 'bottom-right';
  hideOnBlur: boolean;
  autoPaste: boolean;
  hotkeyActivate: string;
  hotkeyWidget: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  historyLimit: 200,
  imageBudgetMB: 512,
  widgetSize: 280,
  widgetCorner: 'bottom-right',
  hideOnBlur: true,
  autoPaste: true,
  hotkeyActivate: 'Control+' + '\u0060',
  hotkeyWidget: 'Alt+C',
};

export interface HotkeyStatus {
  activate: boolean;
  widget: boolean;
  /** 快捷键被系统或其他程序占用时，界面上要如实说明。 */
  conflicts: string[];
}

export interface GhostState {
  active: boolean;
  /** 剩余毫秒数；未激活时为 0。 */
  remainingMs: number;
  /** 计划结束时间戳（毫秒）；未激活时为 null。 */
  until: number | null;
}

export interface PasteResult {
  ok: boolean;
  reason?: 'no-target' | 'elevated' | 'send-failed';
}

export interface Capabilities {
  autoPaste: boolean;
  globalHotkey: boolean;
  backgroundCapture: boolean;
  frostedGlass: boolean;
}

export interface WordCloudData {
  words: { word: string; weight: number }[];
  totalItems: number;
}

/** 界面导航目标：主进程托盘菜单 / 全局热键 -> 渲染进程（Task 9 接线）。 */
export type NavigateTarget = 'list' | 'settings' | 'wordcloud';

/** 连续复制提示（spec §7.5）：只提示 + 预选，**绝不自动合并**。 */
export interface BurstHint {
  ids: string[];
  count: number;
}

/** preload 暴露给渲染进程的完整 API。任何新增能力都必须先加到这里。 */
export interface ClipchanApi {
  items: {
    list(q: ListQuery): Promise<ClipItemDTO[]>;
    paste(id: string): Promise<PasteResult>;
    remove(id: string): Promise<void>;
    togglePin(id: string): Promise<void>;
    clearUnpinned(): Promise<void>;
    clearAll(): Promise<void>;
    mergeSelected(ids: string[]): Promise<{ ok: boolean; id?: string; reason?: string }>;
    getFullImage(id: string): Promise<string>;
    onChanged(cb: () => void): () => void;
    /** 连续复制 3 条：把这几条预选并浮出提示条（不合并）。 */
    onBurstHint(cb: (hint: BurstHint) => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    onChanged(cb: (s: Settings) => void): () => void;
  };
  ghost: {
    get(): Promise<GhostState>;
    set(minutes: number): Promise<GhostState>;
    onChanged(cb: (g: GhostState) => void): () => void;
  };
  app: {
    setMode(mode: 'main' | 'widget'): Promise<void>;
    hide(): Promise<void>;
    setWidgetSize(px: number): Promise<void>;
    /** 小组件按内容设置高度（用户反馈「小组件有一大部分是空白」）。 */
    setWidgetHeight(px: number): Promise<void>;
    /**
     * 自绘缩放手柄：按增量改窗口尺寸。
     * `shape=false` 表示拖拽进行中（先不重设窗口圆角，逐帧 setShape 会掉帧），
     * 松手时用 `shape=true`（或不传）补一次圆角。
     */
    resizeBy(dw: number, dh: number, shape?: boolean): Promise<void>;
    getHotkeyStatus(): Promise<HotkeyStatus>;
    getAutoStart(): Promise<boolean>;
    setAutoStart(on: boolean): Promise<boolean>;
    openDataFolder(): Promise<void>;
    onMode(cb: (mode: 'main' | 'widget') => void): () => void;
    /** 托盘「设置…」/ 热键唤出：要求界面切到某个视图。 */
    onNavigate(cb: (target: NavigateTarget) => void): () => void;
  };
  wordcloud: {
    today(): Promise<WordCloudData>;
    exportPng(): Promise<{ ok: boolean; path?: string }>;
  };
  capabilities: Capabilities;
}

/** 平台适配器就是这套 API；core 只认接口，不认宿主。 */
export type PlatformAdapter = ClipchanApi;
