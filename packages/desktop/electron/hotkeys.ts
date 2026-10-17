/**
 * 全局快捷键注册。
 * ★ 注册失败必须**返回 false 而不是抛** —— 主进程据此在界面上如实说明"快捷键被占用"
 *   （Global Constraints：不假装）。旧版 Ctrl+\u0060 被占用时降级 Ctrl+Alt+C 的语义
 *   在本版里改为"如实告知 + 让用户在设置页改"。
 */
import { globalShortcut } from 'electron';
import type { Settings } from '@clipchan/core';

export interface HotkeyHandlers {
  onActivate: () => void;
  onWidget: () => void;
}

export interface HotkeyRegistration {
  activate: boolean;
  widget: boolean;
  conflicts: string[];
}

/** 注册两个全局快捷键；先清空旧的，避免重设设置时叠加。 */
export function registerHotkeys(settings: Settings, handlers: HotkeyHandlers): HotkeyRegistration {
  globalShortcut.unregisterAll();
  const conflicts: string[] = [];

  const reg = (accelerator: string, fn: () => void): boolean => {
    const accel = (accelerator ?? '').trim();
    if (accel.length === 0) {
      conflicts.push('(空快捷键)');
      return false;
    }
    try {
      const ok = globalShortcut.register(accel, fn);
      if (!ok) conflicts.push(accel);
      return ok;
    } catch {
      // Electron 对非法 accelerator 会抛；按"注册失败"处理，不打断启动。
      conflicts.push(accel);
      return false;
    }
  };

  const activate = reg(settings.hotkeyActivate, handlers.onActivate);
  const widget = reg(settings.hotkeyWidget, handlers.onWidget);
  return { activate, widget, conflicts };
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
