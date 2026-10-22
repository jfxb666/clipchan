/**
 * 自动更新（P0-3）：electron-updater 的薄封装。
 *
 * ★ 本文件顶层**不 import electron-updater**：那个包一加载就 import electron，
 *   而 vitest 跑在纯 node 下（没有 electron 运行时），顶层 import 会让整个
 *   updater.spec.ts 直接炸掉、一条断言都跑不了。所以真正的 require 放在
 *   Updater 构造里，纯逻辑（事件 → 状态映射、能不能安装）抽成可直接测的函数。
 *
 * ★ 更新源是 GitHub Releases（electron-builder.yml 的 publish 段），不需要自建服务器。
 *   拼出来的 latest.yml 地址错了只会让界面永远显示"已是最新"，所以 owner/repo 必须与
 *   实际仓库一致 —— 这是发布配置的坑，不是本文件的逻辑。
 */
import type { UpdateStatus } from '@clipchan/core';

export interface UpdaterDeps {
  /** 当前版本（app.getVersion()），用于"已是最新"这类文案。 */
  currentVersion: string;
  /** 状态推送出口：主进程负责转成 EV.updateStatus 广播给界面。 */
  onStatus: (s: UpdateStatus) => void;
  onLog?: (m: string) => void;
  /**
   * 是否允许联网检查。开发环境必须传 false：
   * 未打包时 electron-updater 没有 app-update.yml，每次检查都会打一次 GitHub 请求
   * 并在控制台刷一条错误，纯噪音。缺省按 false 处理（安全侧默认）。
   */
  enabled?: boolean;
}

/** 检查更新失败时给用户看的话（原始报错只进日志，绝不进渲染进程）。 */
const ERROR_MESSAGE = '检查更新失败，请稍后重试';

function asRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
}

function versionOf(payload: unknown): string | undefined {
  const v = asRecord(payload)?.['version'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * electron-updater 的六个事件 → 界面状态。
 *
 * 未知事件回 null（调用方据此忽略），这样 electron-updater 以后多出事件时
 * 不会把一堆 `state: undefined` 推给界面。
 */
export function statusFromEvent(
  name: string,
  payload?: unknown,
  currentVersion?: string,
): UpdateStatus | null {
  switch (name) {
    case 'checking-for-update':
      return { state: 'checking' };
    case 'update-available': {
      const version = versionOf(payload);
      return version === undefined ? { state: 'available' } : { state: 'available', version };
    }
    case 'update-not-available': {
      // 带上当前版本号：只说"已是最新"用户没法确认自己到底在哪个版本上。
      const message =
        typeof currentVersion === 'string' && currentVersion.length > 0
          ? '已是最新版本（v' + currentVersion + '）'
          : '已是最新版本';
      return { state: 'none', message };
    }
    case 'download-progress': {
      const raw = asRecord(payload)?.['percent'];
      const pct = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      // 夹到 0~100：进度条拿到 103 会画出格，拿到 -1 会回跳。
      const percent = Math.min(100, Math.max(0, Math.round(pct)));
      return { state: 'downloading', percent };
    }
    case 'update-downloaded': {
      const version = versionOf(payload);
      return version === undefined ? { state: 'downloaded' } : { state: 'downloaded', version };
    }
    case 'error':
      // ★ 不把 electron-updater 的原始报错（含堆栈与 URL）传给渲染进程：
      //   对用户没有信息量，还容易把内部地址泄漏到界面上。原始内容走 onLog。
      return { state: 'error', message: ERROR_MESSAGE };
    default:
      return null;
  }
}

/** 只有真的下载完才能安装 —— 否则用户点一下"立即更新"应用就直接退出了。 */
export function canApply(s: UpdateStatus): boolean {
  return s.state === 'downloaded';
}

/** 需要监听的事件名（与 statusFromEvent 的 switch 一一对应）。 */
const EVENTS = [
  'checking-for-update',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
  'error',
] as const;

type AutoUpdaterLike = typeof import('electron-updater').autoUpdater;

export class Updater {
  private readonly deps: UpdaterDeps;
  private readonly enabled: boolean;
  private readonly autoUpdater: AutoUpdaterLike;
  /** 最后一次状态：apply() 靠它判断能不能装。 */
  private status: UpdateStatus = { state: 'idle' };
  private disposed = false;
  private readonly listeners: Array<{ name: string; fn: (payload?: unknown) => void }> = [];

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.enabled = deps.enabled === true;
    // ★ require 放这里而不是文件顶层，理由见文件头注释。
    const mod = require('electron-updater') as typeof import('electron-updater');
    this.autoUpdater = mod.autoUpdater;
    // 静默下载：用户只决定"什么时候装"，下载过程不需要他点确认。
    this.autoUpdater.autoDownload = true;
    // 用户没点"立即更新"就退出应用时，下次启动把已下好的包装上。
    this.autoUpdater.autoInstallOnAppQuit = true;
    this.autoUpdater.logger = {
      info: (m?: unknown) => this.log(String(m)),
      warn: (m?: unknown) => this.log(String(m)),
      error: (m?: unknown) => this.log(String(m)),
      debug: (m?: unknown) => this.log(String(m)),
    };
    this.attach();
  }

  /** 手动检查一次更新（本轮只由设置页的按钮触发，启动时不自动检查）。 */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) {
      const s: UpdateStatus = { state: 'none', message: '开发环境不检查更新' };
      this.push(s);
      return s;
    }
    try {
      this.push({ state: 'checking' });
      await this.autoUpdater.checkForUpdates();
      // 检查结果是靠事件推出去的，这里把最后落定的状态回给调用方（界面按返回值渲染）。
      return this.status;
    } catch (e) {
      this.log('check 失败：' + (e instanceof Error ? e.message : String(e)));
      const s: UpdateStatus = { state: 'error', message: ERROR_MESSAGE };
      this.push(s);
      return s;
    }
  }

  /** 安装已下载的更新并重启。没下载完就什么都不做（见 canApply 注释）。 */
  async apply(): Promise<void> {
    if (!canApply(this.status)) {
      this.log('更新尚未下载完成，忽略安装请求（state=' + this.status.state + '）');
      return;
    }
    try {
      this.autoUpdater.quitAndInstall();
    } catch (e) {
      this.log('quitAndInstall 失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 退出时摘掉监听（will-quit 调用）。 */
  dispose(): void {
    this.disposed = true;
    for (const l of this.listeners) {
      (this.autoUpdater as unknown as { off?: (n: string, f: unknown) => void }).off?.(l.name, l.fn);
    }
    this.listeners.length = 0;
  }

  private attach(): void {
    for (const name of EVENTS) {
      const fn = (payload?: unknown): void => {
        if (this.disposed) return;
        const s = statusFromEvent(name, payload, this.deps.currentVersion);
        if (s === null) return;
        if (name === 'error') this.log('更新事件 error：' + describe(payload));
        this.push(s);
      };
      this.listeners.push({ name, fn });
      (this.autoUpdater as unknown as { on: (n: string, f: (p?: unknown) => void) => void }).on(name, fn);
    }
  }

  private push(s: UpdateStatus): void {
    this.status = s;
    if (this.disposed) return;
    try {
      this.deps.onStatus(s);
    } catch (e) {
      this.log('状态推送失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  private log(m: string): void {
    this.deps.onLog?.(m);
  }
}

function describe(payload: unknown): string {
  if (payload instanceof Error) return payload.message;
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
