/**
 * 「排除的应用」的纯逻辑（v0.6.0 / P0-2）。
 *
 * 主进程按 exe 文件名（小写）比对来源应用；界面这一侧要做的只有三件事：
 * 把用户粘进来的路径归一化、去重、限长。
 */

/** 排除清单上限：再多说明配置出了问题，不如挡住（主进程也有同口径的 clamp）。 */
export const EXCLUDE_APPS_MAX = 50;

/**
 * 把用户输入归一化成 exe 文件名。
 * 用户常常直接粘资源管理器的完整路径（还带引号），所以：去空白 -> 去引号 ->
 * 取 basename（Windows 的 \ 与 POSIX 的 / 都认）-> 转小写。
 */
export function normalizeAppEntry(raw: string): string {
  const unquoted = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  if (unquoted === '') return '';
  const base = unquoted.split(/[\\/]/).at(-1) ?? '';
  return base.trim().toLowerCase();
}

/**
 * 追加一条。空输入 / 已存在 / 超上限一律原样返回**新数组**
 * （新数组是给 React 的：同一个引用不会触发重渲染）。
 */
export function addExcludeApp(list: string[], raw: string): string[] {
  const name = normalizeAppEntry(raw);
  if (name === '') return [...list];
  if (list.includes(name)) return [...list];
  if (list.length >= EXCLUDE_APPS_MAX) return [...list];
  return [...list, name];
}

/** 移除一条（按已存的原值比较，调用方传的就是列表里的那一项）。 */
export function removeExcludeApp(list: string[], name: string): string[] {
  return list.filter((entry) => entry !== name);
}

/** 说明文字：空清单时讲清楚这个功能能挡什么，非空时只报数。 */
export function excludeAppsHint(list: string[]): string {
  if (list.length === 0) {
    return '没有排除任何应用。密码管理器、银行网页这类来源建议加进来，避免明文落库。';
  }
  return '已排除 ' + list.length + ' 个应用，来自它们的复制不会被记录。';
}

/** 一键添加的常用项：主流密码管理器的进程名（已是小写，可直接入库）。 */
export function suggestExcludeApps(): string[] {
  return ['1password.exe', 'keepass.exe', 'bitwarden.exe', 'lastpass.exe', 'enpass.exe'];
}
