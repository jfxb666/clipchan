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
export type NavigateTarget = 'list' | 'settings' | 'wordcloud' | 'optimize';

/** 连续复制提示（spec §7.5）：只提示 + 预选，**绝不自动合并**。 */
export interface BurstHint {
  ids: string[];
  count: number;
}

/** AI 协议（与 @clipchan/ai 的 AiProtocol 镜像：core 不依赖 ai 包，避免构建依赖）。 */
export type AiProtocol = 'openai-compat' | 'anthropic' | 'gemini';

/** 结构化后的 AI 错误：主进程把 HTTP/网络异常统一成这个形状再上抛。 */
export interface AiError {
  kind: 'auth' | 'network' | 'timeout' | 'rate-limit' | 'bad-response' | 'unknown';
  status?: number;
  message: string;
}

/**
 * 给界面看的 provider 投影。
 * ★ 只有掩码（Review Focus 6）：apiKey 绝不出现在这个对象里。
 */
export interface AiProvider {
  id: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyMask: string;
}

/** 保存 provider 的入参：apiKey 只上行，不回读。 */
export interface AiProviderInput {
  id?: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** 一次提示词优化请求（sceneId 由渲染层选，主进程查场景与 Key）。 */
export interface OptimizeRequest {
  providerId: string;
  text: string;
  sceneId: string;
  mode: 'user' | 'system';
  extra?: string;
  /** 渲染层生成的请求标识：流式增量按它配对，过期请求的增量直接丢弃。 */
  requestId: string;
}

/** 流式增量：同一次优化请求的中间结果（只含已可展示的成品文本）。 */
export interface OptimizeDelta {
  requestId: string;
  text: string;
}

export interface OptimizeResult {
  optimized: string;
  notes: string[];
  degraded: boolean;
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
    /** 正文全文（列表预览是截断的）；图片行或 id 不存在 → ''。 */
    getText(id: string): Promise<string>;
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
  clipboard: {
    /** 只写系统剪贴板：不查库、不 touch、不模拟粘贴（优化面板「复制」用）。 */
    writeText(text: string): Promise<void>;
  };
  ai: {
    /** Key 已掩码：只回 keyMask 与 hasKey。 */
    listProviders(): Promise<AiProvider[]>;
    /** apiKey 仅上行；没传就保留原 Key（编辑时不清空）。 */
    saveProvider(p: AiProviderInput): Promise<AiProvider[]>;
    removeProvider(id: string): Promise<AiProvider[]>;
    listModels(id: string): Promise<string[]>;
    test(id: string): Promise<{ ok: boolean; error?: AiError; model?: string }>;
    optimize(req: OptimizeRequest): Promise<OptimizeResult>;
    /** 只投影 id/name/description（rules 不出主进程）。 */
    scenes(): Promise<{ id: string; name: string; description: string }[]>;
    /** 把优化结果写进剪贴板并贴回目标窗口（不进历史、不刷新排序）。 */
    copyAndPaste(text: string): Promise<PasteResult>;
    onChanged(cb: () => void): () => void;
    /** 流式增量：requestId 与发起时一致才采用。 */
    onOptimizeDelta(cb: (delta: OptimizeDelta) => void): () => void;
  };
  capabilities: Capabilities;
}

/** 平台适配器就是这套 API；core 只认接口，不认宿主。 */
export type PlatformAdapter = ClipchanApi;
