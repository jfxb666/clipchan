/**
 * preload 契约测试。
 *
 * ★ preload 本身 import electron，在 Node 里跑不了；所以这里测的是**契约本身**：
 *   channels.ts 的通道表必须与 core 的 ClipchanApi 方法一一对应。少一个通道 =
 *   界面点了没反应；多一个 = 暴露了不该暴露的东西。
 */
import { describe, expect, it } from 'vitest';
import { ALL_INVOKE_CHANNELS, CH, EV } from './channels';

/** core 的 ClipchanApi 上所有"会发请求"的方法名（按 spec §8.1 / types.ts）。 */
const EXPECTED = {
  items: ['list', 'paste', 'remove', 'togglePin', 'clearUnpinned', 'clearAll', 'mergeSelected', 'getFullImage'],
  settings: ['get', 'set'],
  ghost: ['get', 'set'],
  app: [
    'setMode',
    'hide',
    'setWidgetSize',
    'setWidgetHeight',
    'resizeBy',
    'getHotkeyStatus',
    'getAutoStart',
    'setAutoStart',
    'openDataFolder',
    'capabilities',
  ],
  wordcloud: ['today', 'exportPng'],
  ai: ['listProviders', 'saveProvider', 'removeProvider', 'listModels', 'test', 'optimize', 'scenes'],
} as const;

describe('channels 契约', () => {
  it('每个 ClipchanApi 方法都有对应通道', () => {
    for (const [group, methods] of Object.entries(EXPECTED)) {
      const table = (CH as Record<string, Record<string, string> | undefined>)[group];
      expect(table, '缺少分组 ' + group).toBeTruthy();
      if (!table) continue;
      for (const m of methods) {
        expect(typeof table[m], group + '.' + m + ' 没有通道').toBe('string');
      }
    }
  });

  it('通道名唯一且非空', () => {
    const all = ALL_INVOKE_CHANNELS;
    expect(all.length).toBe(new Set(all).size);
    for (const c of all) expect(c.trim().length).toBeGreaterThan(0);
  });

  it('订阅类事件名与 invoke 通道不重名', () => {
    const invokes = new Set<string>(ALL_INVOKE_CHANNELS);
    for (const ev of Object.values(EV)) {
      expect(invokes.has(ev), ev + ' 同时是 invoke 通道与事件名').toBe(false);
    }
  });

  it('capabilities 走同步通道（types.ts 里它是普通对象，不是 Promise）', () => {
    expect(CH.app.capabilities).toBe('app:capabilities');
  });
});
