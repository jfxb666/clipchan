/**
 * 主进程 IPC 注册。
 *
 * ★ 契约来源是 spec §8.1 + packages/core/src/types.ts（types.ts 是权威：界面按它编译）。
 * ★ 通道名统一从 channels.ts 取，preload 与主进程共用同一份常量。
 * ★ Task 4 只搭骨架：未实现的通道**明确抛 not-implemented**，由 Task 5/6/8/9 逐个替换
 *   —— 绝不返回 undefined 假装成功（Global Constraints：不假装）。
 */
import { ipcMain, shell } from 'electron';
import type { Capabilities } from '@clipchan/core';
import { ALL_INVOKE_CHANNELS, CH, EV } from './channels';

export type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;

export interface IpcDeps {
  /** 已实现的通道处理器；缺省的一律 not-implemented。 */
  handlers?: Partial<Record<string, IpcHandler>>;
  /** capabilities 是同步对象（types.ts 里不是 Promise），走 sendSync。 */
  capabilities?: () => Capabilities;
}

/** 已注册通道清单（--smoke 断言"一个都没漏"）。 */
const registered = new Set<string>();

export function registeredChannels(): string[] {
  return [...registered].sort();
}

export function resetRegistry(): void {
  registered.clear();
}

export function registerIpc(deps: IpcDeps = {}): string[] {
  const handlers = deps.handlers ?? {};
  for (const channel of ALL_INVOKE_CHANNELS) {
    // 允许重复注册（dev 下热重启主进程时不会因为 "second handler" 崩掉）。
    ipcMain.removeHandler(channel);
    const impl = handlers[channel];
    if (impl) {
      ipcMain.handle(channel, impl);
    } else {
      ipcMain.handle(channel, () => {
        throw new Error('not-implemented: ' + channel);
      });
    }
    registered.add(channel);
  }

  // capabilities：渲染进程在 preload 阶段同步取一次（types.ts 声明为普通对象）。
  ipcMain.removeAllListeners(CH.app.capabilities);
  ipcMain.on(CH.app.capabilities, (event) => {
    event.returnValue = deps.capabilities ? deps.capabilities() : {
      autoPaste: false,
      globalHotkey: false,
      backgroundCapture: true,
      frostedGlass: false,
    };
  });
  registered.add(CH.app.capabilities);

  // 打开数据目录：不在 spec §8.1 的 invoke 清单里（它是 void），单独一条通道。
  ipcMain.removeAllListeners('app:openPath');
  ipcMain.on('app:openPath', (_e, target: string) => {
    void shell.openPath(String(target));
  });
  return registeredChannels();
}

/** 主进程 -> 渲染进程广播。 */
export interface Broadcaster {
  send(channel: string, payload?: unknown): void;
  itemsChanged(): void;
  settingsChanged(settings: unknown): void;
  ghostChanged(ghost: unknown): void;
  toast(message: string, kind?: 'info' | 'warn' | 'error'): void;
  /** 连续复制提示：把预选 id 交给界面（spec §7.5）。 */
  burstHint(hint: { ids: string[]; count: number }): void;
}

export function makeBroadcaster(getWindow: () => Electron.BrowserWindow | null): Broadcaster {
  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };
  return {
    send,
    itemsChanged: () => send(EV.itemsChanged),
    settingsChanged: (settings) => send(EV.settingsChanged, settings),
    ghostChanged: (ghost) => send(EV.ghostChanged, ghost),
    toast: (message, kind = 'info') => send(EV.toast, { message, kind }),
    burstHint: (hint) => send(EV.burstHint, hint),
  };
}
