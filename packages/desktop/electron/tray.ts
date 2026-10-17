/**
 * 系统托盘。
 *
 * ★ 菜单模板与创建分开：`buildTrayMenu()` 是纯数据（可在 --smoke 里断言文案与数量，
 *   不需要真建 Tray），`createTray()` 才碰 Electron 的 Tray。
 * ★ 旧版有两套"停"状态（永久暂停 + 定时幽灵），新版**合并成一套**（spec §13）：
 *   托盘里的"暂停监听"就是幽灵模式子菜单，避免用户开了永久暂停忘了关。
 */
import { Menu, Tray, app, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { GhostState, Settings } from '@clipchan/core';

export interface TrayHandlers {
  onShowPanel: () => void;
  /** null = 关闭幽灵模式。 */
  onGhost: (minutes: number | null) => void;
  onToggleAutoPaste: (on: boolean) => void;
  onToggleAutoStart: (on: boolean) => void;
  onOpenSettings: () => void;
  onQuit: () => void;
}

export interface TrayState {
  ghost: GhostState;
  settings: Settings;
  autoStart: boolean;
}

/** 幽灵模式快捷档（spec §6.8：5/10/30/60）。 */
export const GHOST_PRESETS = [5, 10, 30, 60] as const;

/** 托盘菜单的顶层文案顺序（--smoke 断言用）。 */
export const TRAY_TOP_LABELS = ['显示面板', '暂停监听（幽灵模式）', 'Enter 自动粘贴', '开机自启', '设置…', '退出'] as const;

export function buildTrayMenu(state: TrayState, handlers: TrayHandlers): MenuItemConstructorOptions[] {
  const ghostMinutes = state.ghost.active && state.ghost.until !== null
    ? Math.max(0, Math.round((state.ghost.until - Date.now()) / 60000))
    : 0;
  const ghostSubmenu: MenuItemConstructorOptions[] = [
    {
      label: ghostMinutes > 0 ? '关闭（剩余 ' + ghostMinutes + ' 分钟）' : '关闭',
      type: 'radio',
      checked: !state.ghost.active,
      click: () => handlers.onGhost(null),
    },
    ...GHOST_PRESETS.map<MenuItemConstructorOptions>((m) => ({
      label: m + ' 分钟',
      type: 'radio',
      checked: state.ghost.active && ghostMinutes > 0 && ghostMinutes <= m,
      click: () => handlers.onGhost(m),
    })),
  ];

  return [
    { label: TRAY_TOP_LABELS[0], click: () => handlers.onShowPanel() },
    { label: TRAY_TOP_LABELS[1], submenu: ghostSubmenu },
    { type: 'separator' },
    {
      label: TRAY_TOP_LABELS[2],
      type: 'checkbox',
      checked: state.settings.autoPaste,
      click: (item) => handlers.onToggleAutoPaste(item.checked),
    },
    {
      label: TRAY_TOP_LABELS[3],
      type: 'checkbox',
      checked: state.autoStart,
      click: (item) => handlers.onToggleAutoStart(item.checked),
    },
    { type: 'separator' },
    { label: TRAY_TOP_LABELS[4], click: () => handlers.onOpenSettings() },
    { label: TRAY_TOP_LABELS[5], click: () => handlers.onQuit() },
  ];
}

/** 真正创建托盘。图标读不到时返回 null（不抛，界面照常能用）。 */
export function createTray(iconPath: string, state: TrayState, handlers: TrayHandlers): Tray | null {
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // 兜底：空图标也能建托盘，只是看不见；不因此让应用起不来。
    image = nativeImage.createEmpty();
  }
  try {
    const tray = new Tray(image);
    tray.setToolTip('剪贴板酱');
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(state, handlers)));
    tray.on('double-click', () => handlers.onShowPanel());
    return tray;
  } catch {
    return null;
  }
}

/**
 * 供 --smoke 断言：菜单里的顶层文案。
 * ★ 跳过 separator（它不是菜单项，不该被算进"6 项"里）。
 */
export function trayLabels(template: MenuItemConstructorOptions[]): string[] {
  return template
    .filter((t) => t.type !== 'separator')
    .map((t) => (typeof t.label === 'string' ? t.label : '(无标题)'));
}

/** 打包/开发期都能找到托盘图标。 */
export function defaultTrayIcon(resourcesPath: string, isPackaged: boolean, repoRoot: string): string {
  const p = require('node:path') as typeof import('node:path');
  return isPackaged ? p.join(resourcesPath, 'build', 'icon.ico') : p.join(repoRoot, 'build', 'icon.ico');
}

export { app };
