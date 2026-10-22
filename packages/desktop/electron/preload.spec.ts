/**
 * preload 契约测试。
 *
 * ★ preload 本身 import electron，在 Node 里跑不了；所以这里测的是**契约本身**：
 *   channels.ts 的通道表必须与 core 的 ClipchanApi 方法一一对应。少一个通道 =
 *   界面点了没反应；多一个 = 暴露了不该暴露的东西。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_INVOKE_CHANNELS, CH, EV } from './channels';

/** preload 的源码：它 import electron，Node 里跑不了，所以契约只能靠读源码来断言。 */
const PRELOAD_SRC = readFileSync(join(__dirname, 'preload.ts'), 'utf8');

/** core 的 ClipchanApi 上所有"会发请求"的方法名（按 spec §8.1 / types.ts）。 */
const EXPECTED = {
  items: [
    'list',
    'paste',
    'remove',
    'togglePin',
    'clearUnpinned',
    'clearAll',
    'mergeSelected',
    'copy',
    'getFullImage',
    'count',
    'exportAll',
    // v0.3.0 T4：zip 备份包导入
    'importAll',
    'getText',
    // v0.3.0 回收站五通道
    'trashList',
    'trashCount',
    'restore',
    'purge',
    'emptyTrash',
    // v0.5.0 T1：OCR 结果「存为一条新记录」
    'saveText',
    // v0.6.0：纯文本粘贴 + 批量操作
    'pastePlain',
    'pasteMany',
    'removeMany',
    'pinMany',
    'startDrag',
  ],
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
    // v0.6.0：自动更新（electron-updater）
    'checkUpdate',
    'applyUpdate',
  ],
  clipboard: ['writeText'],
  wordcloud: ['today', 'exportPng'],
  ai: [
    'listProviders',
    'saveProvider',
    'removeProvider',
    'listModels',
    'test',
    'optimize',
    'cancel',
    'scenes',
    'copyAndPaste',
    // v0.5.0 T1：提示词优化历史
    'history',
    'historyRemove',
    'historyClear',
  ],
  // v0.5.0 T1：截图与 OCR 两组新通道
  capture: ['begin', 'target', 'finish', 'cancel'],
  ocr: ['status', 'download', 'recognize'],
  // v0.6.0：片段库
  snippets: ['list', 'save', 'remove', 'use'],
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

  it('流式增量走事件、只写剪贴板走 invoke：两条新契约各有独立通道', () => {
    // 增量是主进程主动推的，必须是事件名而不是 invoke 通道（invoke 只能渲染层发起）。
    expect(EV.aiOptimizeDelta).toBe('ai:optimize:delta');
    expect(ALL_INVOKE_CHANNELS).not.toContain(EV.aiOptimizeDelta);
    // 「只写剪贴板」与「复制并粘贴」是两个通道：前者不 touch、不模拟粘贴。
    expect(CH.clipboard.writeText).toBe('clipboard:writeText');
    expect(CH.clipboard.writeText).not.toBe(CH.ai.copyAndPaste);
    expect(ALL_INVOKE_CHANNELS).toContain(CH.clipboard.writeText);
  });

  it('capabilities 走同步通道（types.ts 里它是普通对象，不是 Promise）', () => {
    expect(CH.app.capabilities).toBe('app:capabilities');
  });
});

describe('回收站五通道（v0.3.0）：五处同步，漏一处就是运行时 not-implemented', () => {
  const TRASH: [string, string][] = [
    ['trashList', 'items:trashList'],
    ['trashCount', 'items:trashCount'],
    ['restore', 'items:restore'],
    ['purge', 'items:purge'],
    ['emptyTrash', 'items:emptyTrash'],
  ];

  it('① channels.ts 有五个键，② 且都进了 ALL_INVOKE_CHANNELS（Object.values 展平）', () => {
    for (const [key, channel] of TRASH) {
      expect(CH.items[key as keyof typeof CH.items], '缺少通道键 ' + key).toBe(channel);
      expect(ALL_INVOKE_CHANNELS, channel + ' 没进 ALL_INVOKE_CHANNELS').toContain(channel);
    }
  });

  it('④ preload 暴露了五个方法，且各自 invoke 到对应通道常量（不是手写字符串）', () => {
    for (const [key, channel] of TRASH) {
      const re = new RegExp(key + ':[^\\n]*ipcRenderer\\.invoke\\(CH\\.items\\.' + key);
      expect(PRELOAD_SRC, 'preload 缺少 ' + key + ' 或没走 CH.items.' + key).toMatch(re);
      // 手写字符串会绕过通道常量表，改一处就悄悄对不上
      expect(PRELOAD_SRC).not.toContain("'" + channel + "'");
    }
  });

  it('★ preload 不暴露 raw ipcRenderer（只暴露固定方法）', () => {
    expect(PRELOAD_SRC).toContain("contextBridge.exposeInMainWorld('clipchan', api)");
    // 直接把 ipcRenderer 当第二个参数交出去 = 渲染进程能 invoke 任意通道
    expect(PRELOAD_SRC).not.toMatch(/exposeInMainWorld\(\s*['"]clipchan['"]\s*,\s*ipcRenderer\s*\)/);
    // 也不许把 ipcRenderer 挂在暴露对象里
    expect(PRELOAD_SRC).not.toMatch(/^\s*(ipcRenderer|invoke|send|sendSync|on)\s*:/m);
  });
});

describe('app:toast 订阅（v0.3.0）：主进程推的提示必须能到界面', () => {
  // 订阅类方法不是 invoke 通道，进不了 EXPECTED 表（那张表断言的是 CH 表里的键），
  // 所以这里直接读 preload 源码断言"订阅的是 EV.toast 常量、不是手写字符串"。
  it('preload 的 app.onToast 订阅 EV.toast', () => {
    expect(EV.toast).toBe('app:toast');
    expect(PRELOAD_SRC).toMatch(/onToast:\s*\(cb:[^)]*\)[^\n]*on\(EV\.toast, cb\)/);
    // 手写 'app:toast' 会绕过通道常量表，改名时悄悄失效
    expect(PRELOAD_SRC).not.toContain("'app:toast'");
  });

  it('app:toast 是事件而不是 invoke 通道（渲染层只能被动收）', () => {
    expect(ALL_INVOKE_CHANNELS).not.toContain(EV.toast);
  });
});

describe('v0.5.0 T1：截图 / OCR / 优化历史通道', () => {
  /** 与回收站那组同样的四重同步：通道键 → ALL_INVOKE_CHANNELS → preload 方法 → 不手写字符串。 */
  const NEW_CHANNELS: [string, string, string][] = [
    ['items', 'saveText', 'items:saveText'],
    ['capture', 'begin', 'capture:begin'],
    ['capture', 'target', 'capture:target'],
    ['capture', 'finish', 'capture:finish'],
    ['capture', 'cancel', 'capture:cancel'],
    ['ocr', 'status', 'ocr:status'],
    ['ocr', 'download', 'ocr:download'],
    ['ocr', 'recognize', 'ocr:recognize'],
    ['ai', 'history', 'ai:history'],
    ['ai', 'historyRemove', 'ai:historyRemove'],
    ['ai', 'historyClear', 'ai:historyClear'],
  ];

  it('① 通道名逐条对齐（含 items.saveText 的字面值）', () => {
    expect(CH.items.saveText).toBe('items:saveText');
    for (const [group, key, channel] of NEW_CHANNELS) {
      const table = (CH as Record<string, Record<string, string> | undefined>)[group];
      expect(table, '缺少分组 ' + group).toBeTruthy();
      expect(table?.[key], '通道名不对: ' + group + '.' + key).toBe(channel);
    }
  });

  it('② capture 与 ocr 两组整组进了 ALL_INVOKE_CHANNELS', () => {
    for (const channel of Object.values(CH.capture)) {
      expect(ALL_INVOKE_CHANNELS, channel + ' 没进 ALL_INVOKE_CHANNELS').toContain(channel);
    }
    for (const channel of Object.values(CH.ocr)) {
      expect(ALL_INVOKE_CHANNELS, channel + ' 没进 ALL_INVOKE_CHANNELS').toContain(channel);
    }
    for (const [, , channel] of NEW_CHANNELS) {
      expect(ALL_INVOKE_CHANNELS, channel + ' 没进 ALL_INVOKE_CHANNELS').toContain(channel);
    }
  });

  it('③ preload 里 11 个新方法各自 invoke 到对应常量（不是手写字符串）', () => {
    for (const [group, key, channel] of NEW_CHANNELS) {
      const re = new RegExp(key + ':[^\\n]*ipcRenderer\\.invoke\\(CH\\.' + group + '\\.' + key);
      expect(PRELOAD_SRC, 'preload 缺少 ' + key + ' 或没走 CH.' + group + '.' + key).toMatch(re);
      expect(PRELOAD_SRC, '手写了通道字符串 ' + channel).not.toContain("'" + channel + "'");
    }
  });

  it('④ ocr.onProgress 订阅 EV.ocrProgress 并返回取消函数', () => {
    expect(EV.ocrProgress).toBe('ocr:progress');
    // 进度是主进程主动推的：必须是事件名，不能是 invoke 通道
    expect(ALL_INVOKE_CHANNELS).not.toContain(EV.ocrProgress);
    expect(PRELOAD_SRC).toMatch(/onProgress:\s*\(cb:[^)]*\)[^\n]*on\(EV\.ocrProgress, cb\)/);
    expect(PRELOAD_SRC).not.toContain("'ocr:progress'");
  });
});

describe('v0.6.0：批量 / 纯文本 / 片段 / 自动更新通道', () => {
  /** 与前面几组同样的四重同步：通道键 → ALL_INVOKE_CHANNELS → preload 方法 → 不手写字符串。 */
  const V6: [string, string, string][] = [
    ['items', 'pastePlain', 'items:pastePlain'],
    ['items', 'pasteMany', 'items:pasteMany'],
    ['items', 'removeMany', 'items:removeMany'],
    ['items', 'pinMany', 'items:pinMany'],
    ['items', 'startDrag', 'items:startDrag'],
    ['app', 'checkUpdate', 'app:checkUpdate'],
    ['app', 'applyUpdate', 'app:applyUpdate'],
    ['snippets', 'list', 'snippets:list'],
    ['snippets', 'save', 'snippets:save'],
    ['snippets', 'remove', 'snippets:remove'],
    ['snippets', 'use', 'snippets:use'],
  ];

  it('① 通道名逐条对齐', () => {
    for (const [group, key, channel] of V6) {
      const table = (CH as Record<string, Record<string, string> | undefined>)[group];
      expect(table, '缺少分组 ' + group).toBeTruthy();
      expect(table?.[key], '通道名不对: ' + group + '.' + key).toBe(channel);
    }
  });

  it('② 全部进了 ALL_INVOKE_CHANNELS（snippets 整组展平，不手改数组）', () => {
    for (const [, , channel] of V6) {
      expect(ALL_INVOKE_CHANNELS, channel + ' 没进 ALL_INVOKE_CHANNELS').toContain(channel);
    }
  });

  it('③ preload 里每个新方法各自 invoke 到对应常量（不是手写字符串）', () => {
    for (const [group, key, channel] of V6) {
      const re = new RegExp(key + ':[^\\n]*ipcRenderer\\.invoke\\(CH\\.' + group + '\\.' + key);
      expect(PRELOAD_SRC, 'preload 缺少 ' + key + ' 或没走 CH.' + group + '.' + key).toMatch(re);
      expect(PRELOAD_SRC, '手写了通道字符串 ' + channel).not.toContain("'" + channel + "'");
    }
  });

  it('④ 两个新订阅（更新进度 / 片段变更）走事件、不是 invoke 通道', () => {
    for (const ev of [EV.updateStatus, EV.snippetsChanged]) {
      expect(ALL_INVOKE_CHANNELS).not.toContain(ev);
    }
    expect(PRELOAD_SRC).toMatch(/onUpdate:\s*\(cb:[^)]*\)[^\n]*on\(EV\.updateStatus, cb\)/);
    expect(PRELOAD_SRC).toMatch(/onChanged:\s*\(cb:[^)]*\)[^\n]*on\(EV\.snippetsChanged, cb\)/);
  });
});
