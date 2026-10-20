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

/** 回收站查询参数（只有分页；回收站不参与类别/关键词筛选）。 */
export interface TrashQuery {
  limit?: number;
  offset?: number;
}

/**
 * 恢复一条的结果。
 *
 * ★ 用结果对象而不是异常表达"没恢复成"：同内容已在活跃列表时唯一索引会挡住 UPDATE，
 *   这不是错误而是**正常的用户可解释状态**，界面要能提示「同内容已在列表中」。
 */
export interface RestoreResult {
  ok: boolean;
  /** 失败原因：duplicate = 同内容已在活跃列表；missing = id 不在回收站里。 */
  reason?: 'duplicate' | 'missing';
}

/** 硬删（purge / emptyTrash）的结果：removed 是实际删掉的条数。 */
export interface PurgeResult {
  removed: number;
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
  /** 来源可执行文件名，如 "Code.exe"；未知时为 undefined（绝不写 "__unknown__" 这种兜底串）。 */
  sourceApp?: string;
  /** 在回收站里的时间戳；活跃记录为 undefined。 */
  deletedAt?: number;
  /** 图片原始宽高（v0.4.0 瀑布流算列高用）；非图片或无记录时 undefined。 */
  width?: number;
  height?: number;
}

export type ThemeMode = 'auto' | 'light' | 'dark';

/** 列表布局模式（v0.4.0）：只是 list 视图内部的排列方式，不是新的 View。 */
export type ListLayout = 'list' | 'timeline' | 'masonry' | 'source';

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
  /** 截图标注热键（v0.5.0）。 */
  hotkeyCapture: string;
  /** 回收站上限（条）。超出后硬删最旧的回收站记录并删盘。 */
  trashLimit: number;
  /** 列表布局模式（v0.4.0）。只影响排列，不影响筛选。 */
  listLayout: ListLayout;
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
  hotkeyCapture: 'Control+Alt+S',
  trashLimit: 200,
  listLayout: 'list',
};

export interface HotkeyStatus {
  activate: boolean;
  widget: boolean;
  /** v0.5.0 截图热键是否注册成功。 */
  capture: boolean;
  /** 快捷键被系统或其他程序占用时，界面上要如实说明。 */
  conflicts: string[];
}

/** 截图一次的目标显示器（主进程 → overlay 渲染层）。 */
export interface CaptureTarget {
  /** screen.Display.id */
  displayId: number;
  /** 该显示器在 DIP 空间的矩形（overlay 窗口就摆在这）。 */
  bounds: { x: number; y: number; width: number; height: number };
  /** DPI 缩放：底图物理像素 = CSS 像素 × scaleFactor。 */
  scaleFactor: number;
  /** 底图（PNG data URL，物理像素尺寸）。 */
  dataUrl: string;
}

export type CaptureAction = 'copy' | 'paste' | 'save';

export interface CaptureFinishPayload {
  displayId: number;
  /** 裁剪后的 PNG data URL。 */
  pngDataUrl: string;
  action: CaptureAction;
}

export interface CaptureResult {
  ok: boolean;
  /** 落库后的记录 id（成功时必有）。 */
  id?: string;
  /** 用户存文件时点了取消 / 按 Esc 取消截图。 */
  cancelled?: boolean;
  /** ok:false 且非取消时的中文原因。 */
  reason?: string;
}

export type OcrLang = 'eng' | 'chi_sim';

export interface OcrStatus {
  ready: boolean;
  languages: OcrLang[];
  missing: OcrLang[];
  /** 上次失败的中文原因；没失败过为 undefined。 */
  error?: string;
}

export interface OcrProgress {
  phase: 'download' | 'recognize';
  /** 0–1；未知总量时为 -1。 */
  ratio: number;
  message: string;
}

export interface OcrResult {
  text: string;
  /** tesseract 给的 0–100 置信度。 */
  confidence: number;
  ms: number;
}

/** 一次提示词优化的历史记录（v0.5.0）。 */
export interface OptimizeHistoryEntry {
  id: string;
  /** 送进去的原文。 */
  source: string;
  /** 拿回来的结果全文。 */
  output: string;
  sceneId: string;
  mode: 'user' | 'system';
  providerId: string;
  /** provider 名字的快照：provider 后来被删也能看懂这条是谁生成的。 */
  providerName: string;
  createdAt: number;
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

/**
 * 导出为 zip 备份包的结果。
 *
 * ★ 为什么用「ok + cancelled」而不是抛异常表达取消：用户点「取消」是**正常操作**，
 *   不是失败 —— 界面不该弹「导出失败」，也不该把取消当成成功去提示路径。
 */
export interface ExportResult {
  ok: boolean;
  /** 用户在保存对话框里点了取消：既不是成功也不是失败，界面静默返回。 */
  cancelled?: boolean;
  /** 落盘路径（ok:true 时必有）。 */
  path?: string;
  /** 包内记录条数。 */
  items?: number;
  /** 原图文件已丢失、只导出了记录的条数（这些条目导入回来没有图）。 */
  missingImages?: number;
  /** ok:false 且非取消时的原因；如实上报，不假装成功。 */
  reason?: string;
}

/**
 * 从 zip 备份包导入的结果。
 *
 * ★ 四类计数分开报：用户要知道「进来了多少」以及「为什么剩下的没进来」
 *   （重复 / 坏条 / 缺图是三种完全不同的解释）。
 */
export interface ImportResult {
  ok: boolean;
  /** 用户在打开对话框里点了取消。 */
  cancelled?: boolean;
  /** 实际写入的条数。 */
  imported?: number;
  /** 因 id 或内容哈希已存在而跳过的条数（绝不覆盖现有数据）。 */
  skippedDuplicate?: number;
  /** 因条目本身不合法（缺字段 / 包内图片缺失）而跳过的条数。 */
  skippedInvalid?: number;
  /** 其中因包内图片文件缺失而跳过的条数（是 skippedInvalid 的子集）。 */
  missingImages?: number;
  /** ok:false 且非取消时的原因（例如「这不是 Clipchan 的备份包」）。 */
  reason?: string;
}

/**
 * 主进程推给界面的浮层提示（app:toast 的负载）。
 * kind 只有三档，与 ToastTone 的 ok/warn/error 不是一一对应：info 是"说一声"而不是"成功"，
 * 映射集中在 toastText.appToastTone 里，避免两边各写一套。
 */
export interface AppToast {
  message: string;
  kind: 'info' | 'warn' | 'error';
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
    /** 只复制到剪贴板，不贴回原窗口、不消耗目标窗口（右键「复制到剪贴板」）。 */
    copy(id: string): Promise<PasteResult>;
    /**
     * 原图的可展示 URL（桌面端是 clipchan-img://image/... 协议 URL，手机端是 data URL）。
     * 没有原图（文本行 / id 不存在 / 文件已丢）→ ''，不抛。
     */
    getFullImage(id: string): Promise<string>;
    /** 与 list 同条件的总条数（分页时界面要显示"共 N 条"而不是"已加载 N 条"）。 */
    count(q: ListQuery): Promise<number>;
    /**
     * 导出全部活跃记录为 zip 备份包（含原图），落盘路径由用户在保存对话框里选。
     * 用户取消 → { ok:false, cancelled:true }；失败回 ok:false + reason（不假装成功）。
     */
    exportAll(): Promise<ExportResult>;
    /**
     * 从 zip 备份包导入（用户在打开对话框里选包）。
     * 绝不覆盖现有数据：重复 id / 重复哈希一律跳过并计数；用户取消 → cancelled:true。
     */
    importAll(): Promise<ImportResult>;
    /** 正文全文（列表预览是截断的）；图片行或 id 不存在 → ''。 */
    getText(id: string): Promise<string>;
    /** 把一段纯文本存成一条普通记录（kind='text'）。空串回 ok:false。 */
    saveText(text: string): Promise<{ ok: boolean; id?: string }>;
    /** 回收站列表（按删除时间倒序）；缩略图同样走协议 URL。 */
    trashList(q: TrashQuery): Promise<ClipItemDTO[]>;
    /** 回收站总条数（分页显示"共 N 条"）。 */
    trashCount(): Promise<number>;
    /**
     * 从回收站恢复。**同内容已在活跃列表时返回 ok:false / reason:'duplicate'，不抛异常**——
     * 恢复是用户点的"撤销"，不该因为内容重复就报错崩界面；界面据此提示
     * 「同内容已在列表中」。
     */
    restore(id: string): Promise<RestoreResult>;
    /** 永久删除（删盘）。回收站里的行与活跃行都适用。 */
    purge(ids: string[]): Promise<PurgeResult>;
    /** 清空回收站（全部硬删 + 删盘）。 */
    emptyTrash(): Promise<PurgeResult>;
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
    /**
     * 主进程主动推的浮层提示。
     * ★ 主进程才是很多提示的唯一知情方（恢复遇到重复、删盘失败、导入汇总），
     *   不暴露这条订阅，那些 toast 就永远到不了界面，用户看到的是"点了没反应"。
     */
    onToast(cb: (t: AppToast) => void): () => void;
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
    /** 中断一次在途的优化请求（按 requestId）；没有在途请求时静默返回。 */
    cancel(requestId: string): Promise<void>;
    /** 只投影 id/name/description（rules 不出主进程）。 */
    scenes(): Promise<{ id: string; name: string; description: string }[]>;
    /** 把优化结果写进剪贴板并贴回目标窗口（不进历史、不刷新排序）。 */
    copyAndPaste(text: string): Promise<PasteResult>;
    /** 优化历史（最新在前）。主进程在 ai.optimize 成功后自动写入，渲染层只读。 */
    history(limit?: number): Promise<OptimizeHistoryEntry[]>;
    historyRemove(id: string): Promise<void>;
    historyClear(): Promise<void>;
    onChanged(cb: () => void): () => void;
    /** 流式增量：requestId 与发起时一致才采用。 */
    onOptimizeDelta(cb: (delta: OptimizeDelta) => void): () => void;
  };
  capture: {
    /** 抓全部屏幕并建 overlay；已有 overlay 时先取消旧的。用户按 Esc 取消 → null。 */
    begin(): Promise<CaptureTarget[] | null>;
    /** overlay 页面启动时按 displayId 取自己那块底图。 */
    target(displayId: number): Promise<CaptureTarget | null>;
    /** 标注完成：落库 + 按 action 分发。 */
    finish(payload: CaptureFinishPayload): Promise<CaptureResult>;
    /** 取消截图（Esc / 右键）：关掉全部 overlay，不留记录。 */
    cancel(): Promise<void>;
  };
  ocr: {
    status(): Promise<OcrStatus>;
    /** 一键下载缺失语言包；返回下载后的状态。失败回 ok:false 状态 + error。 */
    download(): Promise<OcrStatus>;
    /** 识别一条图片记录（id 是 items.id）。 */
    recognize(id: string): Promise<OcrResult>;
    onProgress(cb: (p: OcrProgress) => void): () => void;
  };
  capabilities: Capabilities;
}

/** 平台适配器就是这套 API；core 只认接口，不认宿主。 */
export type PlatformAdapter = ClipchanApi;
