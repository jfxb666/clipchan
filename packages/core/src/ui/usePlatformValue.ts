import { useEffect, useState } from 'react';
import type { HotkeyStatus } from '../types';
import { getPlatform } from '../platform/adapter';

/**
 * 只读平台数据的取数小钩子（热键状态、开机自启动等）。
 * 系统能力一律经 getPlatform()，core 不 import electron。
 * 非 Electron 环境（浏览器预览 / 单测）里读不到就用 fallback，不打扰用户。
 */
export function usePlatformValue<T>(load: () => Promise<T>, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    let alive = true;
    load()
      .then((next) => {
        if (alive) setValue(next);
      })
      .catch(() => {
        /* 读不到就保持 fallback */
      });
    return () => {
      alive = false;
    };
    // 只在挂载时读一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

const FALLBACK_HOTKEYS: HotkeyStatus = { activate: false, widget: false, conflicts: [] };

/** 热键注册状态（设置页快捷键分区用）。 */
export function useHotkeyStatus(): HotkeyStatus {
  return usePlatformValue(() => getPlatform().app.getHotkeyStatus(), FALLBACK_HOTKEYS);
}

/** 开机自启动状态；null = 尚未读到。 */
export function useAutoStart(): boolean | null {
  return usePlatformValue<boolean | null>(() => getPlatform().app.getAutoStart(), null);
}
