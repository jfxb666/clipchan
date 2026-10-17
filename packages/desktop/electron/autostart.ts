/**
 * 开机自启的应用层封装（Task 10）。
 *
 * ★ 不重复实现路径逻辑：portable.exe 的真实路径解析（PORTABLE_EXECUTABLE_FILE 优先）
 *   已由 startup.ts 的 autoStartPath() 完成并有单测，这里只做「拿结果 + 报错兜底」的薄封装。
 */
import { autoStartPath, getAutoStart, setAutoStart } from './startup';
import type { AutoStartDeps } from './startup';

export interface EnsureAutoStartResult {
  /** 写入是否成功（读取时表示当前是否已开启）。 */
  ok: boolean;
  /** 真正被写进 Run 键的路径：portable 下是用户双击的那个原始 exe。 */
  path: string;
}

/**
 * 读当前自启状态（失败按未开启处理，绝不抛）。
 */
export function readAutoStart(
  deps: AutoStartDeps,
  env: NodeJS.ProcessEnv,
  execPath: string
): EnsureAutoStartResult {
  return {
    ok: getAutoStart(deps, env, execPath),
    path: autoStartPath(env, execPath),
  };
}

/**
 * 设置自启。返回**写入后回读**的状态，避免设置页显示与实际注册表不一致。
 */
export function ensureAutoStart(
  enabled: boolean,
  deps: AutoStartDeps,
  env: NodeJS.ProcessEnv,
  execPath: string
): EnsureAutoStartResult {
  const path = autoStartPath(env, execPath);
  const wrote = setAutoStart(deps, env, execPath, enabled);
  const actual = getAutoStart(deps, env, execPath);
  return { ok: wrote && actual === enabled, path };
}
