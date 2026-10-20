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
  /**
   * v0.5.0 截图标注。
   * ★ 可选：T1 只交付契约层，接线（main.ts 的 beginCapture）在 T6；标成必填会让
   *   主进程在 T1 阶段就编译不过。缺省时按 no-op 注册，行为与"热键生效但没人接"一致，
   *   T6 接上后自然变成真处理。
   */
  onCapture?: () => void;
}

export interface HotkeyRegistration {
  activate: boolean;
  widget: boolean;
  /** v0.5.0 截图热键是否注册成功（设置页要如实显示"注册失败"）。 */
  capture: boolean;
  conflicts: string[];
}

/** 注册三个全局快捷键；先清空旧的，避免重设设置时叠加。 */
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
  const capture = reg(settings.hotkeyCapture, handlers.onCapture ?? (() => {}));
  return { activate, widget, capture, conflicts };
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
