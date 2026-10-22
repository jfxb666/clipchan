/**
 * preload：渲染进程唯一能碰到的桥。
 *
 * ★ 安全约束（Global Constraints）：不开 nodeIntegration、不用 remote，
 *   **绝不把 ipcRenderer 本身暴露出去**，只暴露 core 的 ClipchanApi 上那些固定方法。
 * ★ capabilities 是普通对象（types.ts 不是 Promise），用 sendSync 取一次。
 * ★ 订阅类方法返回**取消函数**（removeListener），界面卸载时调用。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiError,
  AiProvider,
  AiProviderInput,
  AppToast,
  BurstHint,
  Capabilities,
  CaptureFinishPayload,
  CaptureResult,
  CaptureTarget,
  ClipItemDTO,
  ExportResult,
  GhostState,
  HotkeyStatus,
  ImportResult,
  ListQuery,
  NavigateTarget,
  OcrProgress,
  OcrResult,
  OcrStatus,
  OptimizeDelta,
  OptimizeHistoryEntry,
  OptimizeRequest,
  OptimizeResult,
  PasteResult,
  PurgeResult,
  RestoreResult,
  Settings,
  Snippet,
  SnippetInput,
  TrashQuery,
  UpdateStatus,
  WordCloudData,
} from '@clipchan/core';
import { CH, EV } from './channels';

function on(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: any[]): void => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const capabilities = ipcRenderer.sendSync(CH.app.capabilities) as Capabilities;

const api = {
  items: {
    list: (q: ListQuery): Promise<ClipItemDTO[]> => ipcRenderer.invoke(CH.items.list, q),
    paste: (id: string): Promise<PasteResult> => ipcRenderer.invoke(CH.items.paste, id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(CH.items.remove, id),
    togglePin: (id: string): Promise<void> => ipcRenderer.invoke(CH.items.togglePin, id),
    clearUnpinned: (): Promise<void> => ipcRenderer.invoke(CH.items.clearUnpinned),
    clearAll: (): Promise<void> => ipcRenderer.invoke(CH.items.clearAll),
    mergeSelected: (ids: string[]): Promise<{ ok: boolean; id?: string; reason?: string }> =>
      ipcRenderer.invoke(CH.items.mergeSelected, ids),
    copy: (id: string): Promise<PasteResult> => ipcRenderer.invoke(CH.items.copy, id),
    getFullImage: (id: string): Promise<string> => ipcRenderer.invoke(CH.items.getFullImage, id),
    count: (q: ListQuery): Promise<number> => ipcRenderer.invoke(CH.items.count, q),
    exportAll: (): Promise<ExportResult> => ipcRenderer.invoke(CH.items.exportAll),
    importAll: (): Promise<ImportResult> => ipcRenderer.invoke(CH.items.importAll),
    getText: (id: string): Promise<string> => ipcRenderer.invoke(CH.items.getText, id),
    saveText: (text: string): Promise<{ ok: boolean; id?: string }> => ipcRenderer.invoke(CH.items.saveText, text),
    pastePlain: (id: string): Promise<PasteResult> => ipcRenderer.invoke(CH.items.pastePlain, id),
    pasteMany: (ids: string[]): Promise<PasteResult> => ipcRenderer.invoke(CH.items.pasteMany, ids),
    removeMany: (ids: string[]): Promise<number> => ipcRenderer.invoke(CH.items.removeMany, ids),
    pinMany: (ids: string[], pinned: boolean): Promise<void> => ipcRenderer.invoke(CH.items.pinMany, ids, pinned),
    startDrag: (id: string): Promise<void> => ipcRenderer.invoke(CH.items.startDrag, id),
    // ★ 回收站五方法：与 channels.ts 的五个键一一对应（preload.spec 断言不遗漏）。
    trashList: (q: TrashQuery): Promise<ClipItemDTO[]> => ipcRenderer.invoke(CH.items.trashList, q),
    trashCount: (): Promise<number> => ipcRenderer.invoke(CH.items.trashCount),
    restore: (id: string): Promise<RestoreResult> => ipcRenderer.invoke(CH.items.restore, id),
    purge: (ids: string[]): Promise<PurgeResult> => ipcRenderer.invoke(CH.items.purge, ids),
    emptyTrash: (): Promise<PurgeResult> => ipcRenderer.invoke(CH.items.emptyTrash),
    onChanged: (cb: () => void): (() => void) => on(EV.itemsChanged, cb),
    onBurstHint: (cb: (hint: BurstHint) => void): (() => void) => on(EV.burstHint, cb),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(CH.settings.get),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(CH.settings.set, patch),
    onChanged: (cb: (s: Settings) => void): (() => void) => on(EV.settingsChanged, cb),
  },
  ghost: {
    get: (): Promise<GhostState> => ipcRenderer.invoke(CH.ghost.get),
    set: (minutes: number): Promise<GhostState> => ipcRenderer.invoke(CH.ghost.set, minutes),
    onChanged: (cb: (g: GhostState) => void): (() => void) => on(EV.ghostChanged, cb),
  },
  app: {
    setMode: (mode: 'main' | 'widget'): Promise<void> => ipcRenderer.invoke(CH.app.setMode, mode),
    hide: (): Promise<void> => ipcRenderer.invoke(CH.app.hide),
    setWidgetSize: (px: number): Promise<void> => ipcRenderer.invoke(CH.app.setWidgetSize, px),
    setWidgetHeight: (px: number): Promise<void> => ipcRenderer.invoke(CH.app.setWidgetHeight, px),
    resizeBy: (dw: number, dh: number, shape = true): Promise<void> =>
      ipcRenderer.invoke(CH.app.resizeBy, dw, dh, shape),
    getHotkeyStatus: (): Promise<HotkeyStatus> => ipcRenderer.invoke(CH.app.getHotkeyStatus),
    getAutoStart: (): Promise<boolean> => ipcRenderer.invoke(CH.app.getAutoStart),
    setAutoStart: (on: boolean): Promise<boolean> => ipcRenderer.invoke(CH.app.setAutoStart, on),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke(CH.app.openDataFolder),
    checkUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke(CH.app.checkUpdate),
    applyUpdate: (): Promise<void> => ipcRenderer.invoke(CH.app.applyUpdate),
    onUpdate: (cb: (s: UpdateStatus) => void): (() => void) => on(EV.updateStatus, cb),
    onMode: (cb: (mode: 'main' | 'widget') => void): (() => void) => on(EV.modeChanged, cb),
    onNavigate: (cb: (target: NavigateTarget) => void): (() => void) => on(EV.navigate, cb),
    // ★ 主进程主动推的提示（恢复遇重复 / 删盘失败 / 导入汇总）。
    //   没有这条订阅，那几处 broadcast.toast 就是死代码，界面永远收不到。
    onToast: (cb: (t: AppToast) => void): (() => void) => on(EV.toast, cb),
  },
  clipboard: {
    writeText: (text: string): Promise<void> => ipcRenderer.invoke(CH.clipboard.writeText, text),
  },
  wordcloud: {
    today: (): Promise<WordCloudData> => ipcRenderer.invoke(CH.wordcloud.today),
    exportPng: (): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke(CH.wordcloud.exportPng),
  },
  ai: {
    // ★ 全部只走 invoke：Key 由主进程从库里取，渲染进程永远拿不到明文（Review Focus 6）。
    listProviders: (): Promise<AiProvider[]> => ipcRenderer.invoke(CH.ai.listProviders),
    saveProvider: (p: AiProviderInput): Promise<AiProvider[]> => ipcRenderer.invoke(CH.ai.saveProvider, p),
    removeProvider: (id: string): Promise<AiProvider[]> => ipcRenderer.invoke(CH.ai.removeProvider, id),
    listModels: (id: string): Promise<string[]> => ipcRenderer.invoke(CH.ai.listModels, id),
    test: (id: string): Promise<{ ok: boolean; error?: AiError; model?: string }> =>
      ipcRenderer.invoke(CH.ai.test, id),
    optimize: (req: OptimizeRequest): Promise<OptimizeResult> => ipcRenderer.invoke(CH.ai.optimize, req),
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke(CH.ai.cancel, requestId),
    scenes: (): Promise<{ id: string; name: string; description: string }[]> => ipcRenderer.invoke(CH.ai.scenes),
    copyAndPaste: (text: string): Promise<PasteResult> => ipcRenderer.invoke(CH.ai.copyAndPaste, text),
    // 历史由主进程写（Ruling 5）：渲染层只有读与删，没有"写一条历史"的方法。
    history: (limit?: number): Promise<OptimizeHistoryEntry[]> => ipcRenderer.invoke(CH.ai.history, limit),
    historyRemove: (id: string): Promise<void> => ipcRenderer.invoke(CH.ai.historyRemove, id),
    historyClear: (): Promise<void> => ipcRenderer.invoke(CH.ai.historyClear),
    onChanged: (cb: () => void): (() => void) => on(EV.aiChanged, cb),
    onOptimizeDelta: (cb: (delta: OptimizeDelta) => void): (() => void) => on(EV.aiOptimizeDelta, cb),
  },
  capture: {
    begin: (): Promise<CaptureTarget[] | null> => ipcRenderer.invoke(CH.capture.begin),
    target: (displayId: number): Promise<CaptureTarget | null> => ipcRenderer.invoke(CH.capture.target, displayId),
    finish: (payload: CaptureFinishPayload): Promise<CaptureResult> => ipcRenderer.invoke(CH.capture.finish, payload),
    cancel: (): Promise<void> => ipcRenderer.invoke(CH.capture.cancel),
  },
  ocr: {
    // ★ 识别引擎只在主进程跑（tesseract.js 是 CJS + worker + WASM，渲染进程跑不了），
    //   所以这里全是 invoke，渲染层拿到的只有文本。
    status: (): Promise<OcrStatus> => ipcRenderer.invoke(CH.ocr.status),
    download: (): Promise<OcrStatus> => ipcRenderer.invoke(CH.ocr.download),
    recognize: (id: string): Promise<OcrResult> => ipcRenderer.invoke(CH.ocr.recognize, id),
    onProgress: (cb: (p: OcrProgress) => void): (() => void) => on(EV.ocrProgress, cb),
  },
  snippets: {
    list: (): Promise<Snippet[]> => ipcRenderer.invoke(CH.snippets.list),
    save: (input: SnippetInput): Promise<Snippet[]> => ipcRenderer.invoke(CH.snippets.save, input),
    remove: (id: string): Promise<Snippet[]> => ipcRenderer.invoke(CH.snippets.remove, id),
    use: (id: string): Promise<Snippet[]> => ipcRenderer.invoke(CH.snippets.use, id),
    onChanged: (cb: () => void): (() => void) => on(EV.snippetsChanged, cb),
  },
  capabilities,
};

contextBridge.exposeInMainWorld('clipchan', api);

export type PreloadApi = typeof api;
