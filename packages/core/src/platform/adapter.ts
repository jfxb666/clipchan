import type { ClipchanApi, PlatformAdapter } from '../types';

/**
 * 平台适配器的注入点。渲染进程里由 preload 通过 contextBridge 把实现挂到
 * `globalThis.clipchan`；单测与浏览器预览时用 setPlatform 注入假实现。
 *
 * 没有实现时返回一个**每个方法都 reject 并带中文说明**的桩，这样界面在
 * 非 Electron 环境下不会静默白屏，而是能显示"当前环境不支持"。
 */

let injected: PlatformAdapter | null = null;

function notAvailable(name: string): never {
  throw new Error('当前环境没有实现 ' + name + '（不在 Electron 中运行，或 preload 未加载）');
}

const unsubscribe = () => () => {};

const stub: PlatformAdapter = {
  items: {
    list: () => Promise.reject(new Error('当前环境没有实现 items.list')),
    paste: () => Promise.reject(new Error('当前环境没有实现 items.paste')),
    remove: () => Promise.reject(new Error('当前环境没有实现 items.remove')),
    togglePin: () => Promise.reject(new Error('当前环境没有实现 items.togglePin')),
    clearUnpinned: () => Promise.reject(new Error('当前环境没有实现 items.clearUnpinned')),
    clearAll: () => Promise.reject(new Error('当前环境没有实现 items.clearAll')),
    mergeSelected: () => Promise.reject(new Error('当前环境没有实现 items.mergeSelected')),
    copy: () => Promise.reject(new Error('当前环境没有实现 items.copy')),
    getFullImage: () => Promise.reject(new Error('当前环境没有实现 items.getFullImage')),
    count: () => Promise.reject(new Error('当前环境没有实现 items.count')),
    exportAll: () => Promise.reject(new Error('当前环境没有实现 items.exportAll')),
    getText: () => Promise.reject(new Error('当前环境没有实现 items.getText')),
    onChanged: () => unsubscribe(),
    onBurstHint: () => unsubscribe(),
  },
  settings: {
    get: () => Promise.reject(new Error('当前环境没有实现 settings.get')),
    set: () => Promise.reject(new Error('当前环境没有实现 settings.set')),
    onChanged: () => unsubscribe(),
  },
  ghost: {
    get: () => Promise.reject(new Error('当前环境没有实现 ghost.get')),
    set: () => Promise.reject(new Error('当前环境没有实现 ghost.set')),
    onChanged: () => unsubscribe(),
  },
  app: {
    setMode: () => Promise.reject(new Error('当前环境没有实现 app.setMode')),
    hide: () => Promise.reject(new Error('当前环境没有实现 app.hide')),
    setWidgetSize: () => Promise.reject(new Error('当前环境没有实现 app.setWidgetSize')),
    setWidgetHeight: () => Promise.reject(new Error('当前环境没有实现 app.setWidgetHeight')),
    resizeBy: (_dw, _dh, _shape) => Promise.reject(new Error('当前环境没有实现 app.resizeBy')),
    getHotkeyStatus: () => Promise.reject(new Error('当前环境没有实现 app.getHotkeyStatus')),
    getAutoStart: () => Promise.reject(new Error('当前环境没有实现 app.getAutoStart')),
    setAutoStart: () => Promise.reject(new Error('当前环境没有实现 app.setAutoStart')),
    openDataFolder: () => Promise.reject(new Error('当前环境没有实现 app.openDataFolder')),
    onMode: () => unsubscribe(),
    onNavigate: () => unsubscribe(),
  },
  wordcloud: {
    today: () => Promise.reject(new Error('当前环境没有实现 wordcloud.today')),
    exportPng: () => Promise.reject(new Error('当前环境没有实现 wordcloud.exportPng')),
  },
  clipboard: {
    writeText: () => Promise.reject(new Error('当前环境没有实现 clipboard.writeText')),
  },
  ai: {
    listProviders: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    saveProvider: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    removeProvider: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    listModels: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    test: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    optimize: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    cancel: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    scenes: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    copyAndPaste: () => Promise.reject(new Error(notAvailable('AI 提示词优化'))),
    onChanged: () => unsubscribe(),
    onOptimizeDelta: () => unsubscribe(),
  },
  capabilities: {
    autoPaste: false,
    globalHotkey: false,
    backgroundCapture: false,
    frostedGlass: false,
  },
};

export function getPlatform(): PlatformAdapter {
  if (injected) return injected;
  const g = globalThis as unknown as { clipchan?: ClipchanApi };
  if (g.clipchan) return g.clipchan;
  return stub;
}

/** 测试与浏览器预览用；传 null 恢复默认探测。 */
export function setPlatform(p: PlatformAdapter | null): void {
  injected = p;
}
