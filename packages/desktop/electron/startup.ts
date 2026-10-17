/**
 * 启动自检与副作用注册（单实例锁、自启、退出清理）。
 *
 * ★ 这些函数**不 import electron 的类型做重活**，只接收注入的依赖 —— 这样能在
 *   Node 里直接单测（本机跑不起真正的 Electron 单元测试）。
 */

export interface SingleInstanceDeps {
  /** 返回 true 表示拿到锁（本次是首实例）。 */
  requestLock: () => boolean;
  /** 没拿到锁时要走的分支（唤出已运行的面板）。 */
  onSecondInstance: () => void;
  quit: () => void;
}

/**
 * 单实例：拿不到锁直接退出，并把"唤出已存在面板"交给 second-instance 事件。
 * ★ 旧版用的是 Global\Clipchan.SingleInstance.v1 互斥体；新版换 app.requestSingleInstanceLock()
 *   （spec §13），但语义一致：绝不出现两个轮询器 / 两个托盘图标 / SQLite 双写。
 * @returns 是否是首实例
 */
export function enforceSingleInstance(deps: SingleInstanceDeps): boolean {
  if (deps.requestLock()) return true;
  deps.onSecondInstance();
  deps.quit();
  return false;
}

export interface AutoStartDeps {
  getLoginItemSettings: (opts?: { path?: string }) => { openAtLogin: boolean };
  setLoginItemSettings: (opts: { openAtLogin: boolean; path?: string; args?: string[] }) => void;
}

/**
 * 开机自启。
 * ★ portable.exe 每次从临时目录解压运行，把 process.execPath 写进 Run 键会在重启后失效；
 *   electron-builder 的 portable.nsi:77-79 注入了 PORTABLE_EXECUTABLE_FILE，指向用户双击的
 *   那个原始 exe（spec §8.3 / §15 实测第 19 条）。
 */
export function autoStartPath(env: NodeJS.ProcessEnv, execPath: string): string {
  const portable = env.PORTABLE_EXECUTABLE_FILE;
  return portable && portable.trim().length > 0 ? portable : execPath;
}

export function getAutoStart(deps: AutoStartDeps, env: NodeJS.ProcessEnv, execPath: string): boolean {
  try {
    return deps.getLoginItemSettings({ path: autoStartPath(env, execPath) }).openAtLogin;
  } catch {
    return false;
  }
}

/**
 * 写自启设置。
 * ★ 返回值是"**写入是否成功**"，不是"当前是否开启"。
 *   曾经返回传入的 `on`，于是关闭时（on=false）永远返回 false →
 *   ensureAutoStart 的 `wrote && actual === enabled` 恒为 false →
 *   设置页把已经关掉的开关又回滚成"开"（真机实测：注册表已清空、界面仍显示开启）。
 *   on=true 时两种语义碰巧一致，所以这个 bug 只在关闭方向暴露。
 */
export function setAutoStart(
  deps: AutoStartDeps,
  env: NodeJS.ProcessEnv,
  execPath: string,
  on: boolean
): boolean {
  try {
    deps.setLoginItemSettings({ openAtLogin: on, path: autoStartPath(env, execPath) });
    return true;
  } catch {
    return false;
  }
}
