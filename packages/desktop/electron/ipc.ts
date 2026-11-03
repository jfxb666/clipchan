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

  // ★ 拖出到外部：同一个通道名同时挂"单向 send"与"invoke"两套。
  //   界面必须走 send —— 拖拽得在 dragstart 的同步栈里发起，invoke 是一次异步往返，
  //   等主进程收到消息时 Chromium 早把这次拖拽收尾了，DoDragDrop 拿不到按下的鼠标键，
  //   表现就是"拖了没反应、也没有任何提示"。invoke 那套留给其它调用方 await 用。
  const startDragImpl = handlers[CH.items.startDrag];
  ipcMain.removeAllListeners(CH.items.startDrag);
  ipcMain.on(CH.items.startDrag, (e, id: string) => {
    try {
      void startDragImpl?.(e as unknown as Electron.IpcMainInvokeEvent, id);
    } catch (err) {
      console.warn('[drag] 发起拖拽失败：' + String(err));
    }
  });
  registered.add(CH.items.startDrag);

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

/** 两条 itemsChanged 之间的最小合并窗口：与 AI 增量通道同源的一个数量级，够吃掉一次批量操作。 */
export const ITEMS_CHANGED_COALESCE_MS = 120;

/** 主进程 -> 渲染进程广播。 */
export interface Broadcaster {
  send(channel: string, payload?: unknown): void;
  /** ★ 只发信号不带数据，且带 120ms 合并窗口（见 makeBroadcaster）：渲染层收到后全量重拉即可。 */
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

export interface BroadcasterOptions {
  /** 合并窗口：0 = 关闭合并，每条都即时发（测试与需要严格顺序的调用方用）。 */
  coalesceMs?: number;
  /** 时钟（与 deltaThrottle 的依赖形状对齐）；当前合并只看定时器，不读时钟。 */
  now?: () => number;
  /** 定时器可注入（测试用假定时器，不真等 120ms）。 */
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** 合并用"窗口内跳过"语义，从不取消已排的定时器；收进接口只为与 setTimeout 对称。 */
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * 事件出口。
 *
 * ★ itemsChanged 带 120ms 合并窗口：主进程有 20 多个调用点，渲染层收到就重拉整页，
 *   批量操作（收藏 N 条 / 删除 N 条 / 连续复制）会在同一秒打出十几次全量 list，
 *   界面就在那儿闪。合并的是**信号**不是数据 —— 反正渲染层拿到信号后拉的是最新全量，
 *   中间态没有信息量，丢中间帧不丢正确性。
 * ★ 其它事件一律即时：toast 迟到 120ms 用户会觉得"点了没反应"，settingsChanged
 *   合并会把两次不同载荷压成一次随机载荷。
 */
export function makeBroadcaster(
  getWindow: () => Electron.BrowserWindow | null,
  opts: BroadcasterOptions = {},
): Broadcaster {
  const coalesceMs = typeof opts.coalesceMs === 'number' && Number.isFinite(opts.coalesceMs)
    ? Math.max(0, opts.coalesceMs)
    : ITEMS_CHANGED_COALESCE_MS;
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));

  const send = (channel: string, payload?: unknown): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  const itemsChanged = (): void => {
    if (coalesceMs === 0) { send(EV.itemsChanged); return; }
    // 合并期内后来的调用只是"再确认一次有变更"：定时器只有一条，不重排也不取消。
    if (pending !== null) return;
    pending = setT(() => {
      pending = null;
      send(EV.itemsChanged);
    }, coalesceMs);
  };

  return {
    send,
    itemsChanged,
    settingsChanged: (settings) => send(EV.settingsChanged, settings),
    ghostChanged: (ghost) => send(EV.ghostChanged, ghost),
    toast: (message, kind = 'info') => send(EV.toast, { message, kind }),
    burstHint: (hint) => send(EV.burstHint, hint),
    aiChanged: () => send(EV.aiChanged),
    // ★ 事件载荷与 core 的 OptimizeDelta 逐字同形：渲染层拿到就能直接 mergeDelta。
    aiOptimizeDelta: (requestId, text) => send(EV.aiOptimizeDelta, { requestId, text }),
  };
}
