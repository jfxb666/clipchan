/**
 * IPC 通道名常量表。
 *
 * ★ 单独放一个不 import electron 的模块：preload（渲染侧）与 ipc.ts（主进程）都要用，
 *   两边共用同一份常量才不会出现"主进程注册了 items:list、preload 却 invoke items:listAll"。
 *   通道名是契约（spec §8.1），新增能力必须先加到 core 的 ClipchanApi 再改这里。
 */

export const CH = {
  items: {
    list: 'items:list',
    paste: 'items:paste',
    remove: 'items:remove',
    togglePin: 'items:togglePin',
    clearUnpinned: 'items:clearUnpinned',
    clearAll: 'items:clearAll',
    mergeSelected: 'items:mergeSelected',
    getFullImage: 'items:getFullImage',
  },
  settings: { get: 'settings:get', set: 'settings:set' },
  ghost: { get: 'ghost:get', set: 'ghost:set' },
  app: {
    setMode: 'app:setMode',
    hide: 'app:hide',
    setWidgetSize: 'app:setWidgetSize',
    setWidgetHeight: 'app:setWidgetHeight',
    resizeBy: 'app:resizeBy',
    getHotkeyStatus: 'app:getHotkeyStatus',
    getAutoStart: 'app:getAutoStart',
    setAutoStart: 'app:setAutoStart',
    openDataFolder: 'app:openDataFolder',
    capabilities: 'app:capabilities',
  },
  wordcloud: { today: 'wordcloud:today', exportPng: 'wordcloud:exportPng' },
} as const;

/** 主进程 -> 渲染进程的单向事件。 */
export const EV = {
  itemsChanged: 'items:changed',
  settingsChanged: 'settings:changed',
  ghostChanged: 'ghost:changed',
  modeChanged: 'app:mode',
  navigate: 'app:navigate',
  toast: 'app:toast',
  /** 连续复制提示（主进程 -> 界面）。 */
  burstHint: 'items:burstHint',
} as const;

/** 所有 invoke 通道的扁平清单（--smoke 用来断言"一个都没漏"）。 */
export const ALL_INVOKE_CHANNELS: string[] = [
  ...Object.values(CH.items),
  ...Object.values(CH.settings),
  ...Object.values(CH.ghost),
  ...Object.values(CH.app),
  ...Object.values(CH.wordcloud),
];
