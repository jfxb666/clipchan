/**
 * 主进程 IPC 注册。
 *
 * ★ 契约来源是 spec §8.1 + packages/core/src/types.ts（types.ts 是权威：界面按它编译）。
 * ★ 通道名统一从 channels.ts 取，preload 与主进程共用同一份常量。
 * ★ Task 4 只搭骨架：未实现的通道**明确抛 not-implemented**，由 Task 5/6/8/9 逐个替换
 *   —— 绝不返回 undefined 假装成功（Global Constraints：不假装）。
 */
import { ipcMain, shell } from 'electron';
import type { Capabilities, RestoreResult } from '@clipchan/core';
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

/**
 * 把处理器抛出的东西包成 Error。Electron 的 ipcMain.handle 只序列化 Error 实例的
 * message/name/stack，throw 普通对象（如 @clipchan/ai 的 AiError）会在渲染层变成
 * "Error invoking remote method 'x': [object Object]"——结构化信息全丢。
 */
export function toIpcError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === 'string') return new Error(e);
  const message = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof message === 'string' && message.trim()) return new Error(message);
  // 无 message 的对象用 JSON 表示（String({}) 也是 "[object Object]"）；循环引用再退回 String。
  try {
    return new Error(JSON.stringify(e));
  } catch {
    return new Error(String(e));
  }
}

export function registerIpc(deps: IpcDeps = {}): string[] {
  const handlers = deps.handlers ?? {};
  for (const channel of ALL_INVOKE_CHANNELS) {
    // 允许重复注册（dev 下热重启主进程时不会因为 "second handler" 崩掉）。
    ipcMain.removeHandler(channel);
    const impl = handlers[channel];
    if (impl) {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        try {
          return await impl(event, ...args);
        } catch (e) {
          throw toIpcError(e);
        }
      });
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

/**
 * 恢复一条并把"没恢复成"翻译成可读结果。
 *
 * ★ 为什么不用异常：db.restore 在同内容已占住活跃行时返回 false（唯一索引挡住 UPDATE），
 *   这是**正常的用户可解释状态**而不是错误。抛异常会让渲染层只看到一句
 *   "Error invoking remote method 'items:restore'" 然后界面静默失败。
 * ★ 两种失败必须分开：行还在回收站 = duplicate（同内容已在列表）；
 *   行已经不在了 = missing（被 purge 或 id 不存在）。
 */
export interface RestoreCapableDb {
  restore(id: string): boolean;
  getRow(id: string): { deleted_at: number | null } | null;
}

export function runRestore(db: RestoreCapableDb, id: string): RestoreResult {
  if (db.restore(id)) return { ok: true };
  const row = db.getRow(id);
  if (row && typeof row.deleted_at === 'number') return { ok: false, reason: 'duplicate' };
  return { ok: false, reason: 'missing' };
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
  /** provider 列表变了（只发信号，不带数据）。 */
  aiChanged(): void;
  /** 流式增量：text 是"本次新增的尾巴"，渲染层按 requestId 配对后追加。 */
  aiOptimizeDelta(requestId: string, text: string): void;
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
    aiChanged: () => send(EV.aiChanged),
    // ★ 事件载荷与 core 的 OptimizeDelta 逐字同形：渲染层拿到就能直接 mergeDelta。
    aiOptimizeDelta: (requestId, text) => send(EV.aiOptimizeDelta, { requestId, text }),
  };
}
