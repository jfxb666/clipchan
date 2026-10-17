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
  BurstHint,
  Capabilities,
  ClipItemDTO,
  GhostState,
  HotkeyStatus,
  ListQuery,
  NavigateTarget,
  OptimizeRequest,
  OptimizeResult,
  PasteResult,
  Settings,
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
    getFullImage: (id: string): Promise<string> => ipcRenderer.invoke(CH.items.getFullImage, id),
    getText: (id: string): Promise<string> => ipcRenderer.invoke(CH.items.getText, id),
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
    onMode: (cb: (mode: 'main' | 'widget') => void): (() => void) => on(EV.modeChanged, cb),
    onNavigate: (cb: (target: NavigateTarget) => void): (() => void) => on(EV.navigate, cb),
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
    scenes: (): Promise<{ id: string; name: string; description: string }[]> => ipcRenderer.invoke(CH.ai.scenes),
    copyAndPaste: (text: string): Promise<PasteResult> => ipcRenderer.invoke(CH.ai.copyAndPaste, text),
    onChanged: (cb: () => void): (() => void) => on(EV.aiChanged, cb),
  },
  capabilities,
};

contextBridge.exposeInMainWorld('clipchan', api);

export type PreloadApi = typeof api;
