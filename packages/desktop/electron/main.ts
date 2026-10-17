/**
 * Electron 主进程入口。
 *
 * ★ Task 4 的职责：把窗口、托盘、热键、单实例、自启、IPC 骨架立起来。
 * ★ Task 5/6/9 会往 `buildHandlers()` 里继续填 items.paste / ghost / wordcloud —— 本文件
 *   用"处理器表"而不是散落的 ipcMain.handle，正是为了让那些任务只改一处。
 * ★ --smoke：创建窗口、切两次形态、回读尺寸、打印一行 SMOKE {...} 后退出 0
 *   （给 scripts/smoke-main.mjs 断言用，不需要人眼看）。
 */
import { Menu, app, BrowserWindow, clipboard, dialog, nativeImage, net, protocol, screen } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@clipchan/core';
import type { Capabilities, GhostState, NavigateTarget, Settings } from '@clipchan/core';
import { adapterFor } from '@clipchan/ai';
import { optimize as runOptimize } from '@clipchan/ai';
import { CH, EV } from './channels';
import { createAi } from './ai';
import type { AiApi } from './ai';
import { openDb } from './db';
import type { Db, InsertResult } from './db';
import { runLegacyMigration } from './migrate-runner';
import { clearUnpinnedWithFiles, deleteImageFiles, enforceImageBudget, removeItemsWithFiles } from './images';
import { sweepOrphans } from './images-policy';
import { imageAbs, imagesDir, thumbsDir, dbFile, resolveDataDir } from './paths';
import { THUMB_SCHEME, mapThumbUrl, resolveThumbRequest } from './thumb-url';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { makeBroadcaster, registerIpc, registeredChannels } from './ipc';
import type { IpcHandler } from './ipc';
import { createTray, defaultTrayIcon, trayLabels, buildTrayMenu } from './tray';
import { autoStartPath, enforceSingleInstance } from './startup';
import { ensureAutoStart, readAutoStart } from './autostart';
import { applyMode, assetPath, createMainWindow, loadRenderer, resizeBy, setWidgetHeight } from './windows';
import type { WinMode } from './windows';
import { HelperClient, defaultHelperExePath, packagedHelperExePath } from './helper';
import { TargetTracker } from './target-tracker';
import { PasteService } from './paste';
import { Recorder } from './recorder';
import { ClipboardWatcher } from './watcher';
import { Ghost } from './ghost';
import { FrostedGlass, handleOf } from './frosted';
import { BurstDetector, showBurstBalloon } from './burst';
import { MergeService } from './merge-service';
import { wordCloudToday } from './wordcloud';
import type { RecordSink } from './watcher';

const SMOKE = process.argv.includes('--smoke');
/** 启动即为小组件形态（--widget，旧版 --ghost 的位置）。 */
const START_WIDGET = process.argv.includes('--widget');

/**
 * ★ 缩略图协议必须在 app ready **之前**声明特权，否则 <img> 会被 CSP/安全策略挡下。
 * 真机上图片卡片显示破图就是这个协议一直没实现（库里存的是相对路径）。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: THUMB_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

/** 全局状态（主进程只有一份，单实例锁保证了这点）。 */
interface Runtime {
  win: BrowserWindow | null;
  tray: ReturnType<typeof createTray>;
  db: Db | null;
  dataDir: string;
  mode: WinMode;
  settings: Settings | null;
  ghost: GhostState;
  hotkeyStatus: { activate: boolean; widget: boolean; conflicts: string[] };
  autoStart: boolean;
}

const rt: Runtime = {
  win: null,
  tray: null,
  db: null,
  dataDir: '',
  mode: START_WIDGET ? 'widget' : 'main',
  settings: null,
  ghost: { active: false, remainingMs: 0, until: null },
  hotkeyStatus: { activate: false, widget: false, conflicts: [] },
  autoStart: false,
};

/**
 * 运行时服务句柄（Task 5/6/8 接线）。
 *
 * ★ 为什么放模块级而不是塞进 Runtime：它们都是"建好就不再换"的单例，
 *   而 Runtime 是给 --smoke / 托盘读的**状态**快照。混在一起会让托盘多拿到一堆内部对象。
 */
let helperClient: HelperClient | null = null;
let tracker: TargetTracker | null = null;
let frosted: FrostedGlass | null = null;
let watcher: ClipboardWatcher | null = null;
let ghostSvc: Ghost | null = null;
let pasteSvc: PasteService | null = null;
/** 拼接服务（spec §7.5：用户按 Ctrl+M 才合并，永不自动合并）。 */
let mergeSvc: MergeService | null = null;
/** 连续复制检测器（2 秒内 3 条 → 只预选 + 提示）。 */
let burstDetector: BurstDetector | null = null;
/** 面板不可见时攒下的预选 id，等下次显示面板再发给界面（照抄 legacy MainForm.cs:596-598）。 */
let pendingBurstIds: string[] = [];

/** 广播器在 buildHandlers() 里才创建；AI 桥用它的 aiChanged 通道。 */
let aiBroadcast: { aiChanged(): void } = { aiChanged: () => {} };

/**
 * AI 桥（Task 5 Step 4）。
 * ★ 这里只做"依赖装配"：kv 从库来、adapterFor/optimize 从 @clipchan/ai 来，
 *   业务逻辑全在 ai.ts 里（那才测得了）。
 */
let aiApi: AiApi | null = null;
function buildAiApi(getBroadcast: () => { aiChanged(): void }): AiApi {
  return createAi({
    kv: {
      getSettingValue: <T,>(key: string): T | undefined => {
        if (!rt.db) throw new Error('数据库尚未就绪');
        return rt.db.getSettingValue<T>(key);
      },
      setSettingValue: (key: string, value: unknown): void => {
        if (!rt.db) throw new Error('数据库尚未就绪');
        rt.db.setSettingValue(key, value);
      },
    },
    adapterFor,
    optimize: runOptimize,
    // ★ Key 变了只发"变了"这一件事，数据让界面自己重取（事件里不带任何 provider 字段）。
    onChanged: () => getBroadcast().aiChanged(),
  });
}

/** 导出今日词云：量出 [data-cc-wordcloud] 的矩形再截那一片（spec §9 步骤⑥）。 */
const MEASURE_WORDCLOUD_JS =
  "(() => { const el = document.querySelector('[data-cc-wordcloud]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()";

async function exportWordCloudPng(): Promise<{ ok: boolean; path?: string }> {
  const win = rt.win;
  if (!win || win.isDestroyed()) return { ok: false };
  const rect = (await win.webContents.executeJavaScript(MEASURE_WORDCLOUD_JS)) as { x: number; y: number; width: number; height: number } | null;
  if (!rect || rect.width < 1 || rect.height < 1) return { ok: false };
  const image = await win.webContents.capturePage(rect);
  if (image.isEmpty()) return { ok: false };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const picked = await dialog.showSaveDialog(win, {
    title: '导出今日词云',
    defaultPath: path.join(app.getPath('pictures'), 'clipchan-wordcloud-' + stamp + '.png'),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false };
  fs.writeFileSync(picked.filePath, image.toPNG());
  return { ok: true, path: picked.filePath };
}

/** 请求界面切视图（托盘「设置…」与全局热键唤出都走这里）。 */
function navigateTo(target: NavigateTarget): void {
  rt.win?.webContents.send(EV.navigate, target);
}

/** 面板可见时立刻把预选 id 发给界面；提示条 5 秒后由界面自己淡出。 */
function flushPendingBurst(): void {
  if (pendingBurstIds.length === 0) return;
  const ids = pendingBurstIds;
  pendingBurstIds = [];
  makeBroadcaster(() => rt.win).burstHint({ ids: ids, count: ids.length });
}

/** 记录成功后的统一后处理：刷新面板列表 + 连续复制检测。 */
function afterRecord(result: InsertResult | null): InsertResult | null {
  if (!result || result.touched) return result;
  makeBroadcaster(() => rt.win).itemsChanged();
  const detector = burstDetector;
  if (!detector) return result;
  const note = detector.note(result.id);
  if (!note.triggered) return result;
  pendingBurstIds = note.ids;
  const win = rt.win;
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
  if (visible) flushPendingBurst();
  else showBurstBalloon(rt.tray, note.ids.length);
  return result;
}

/** 渲染进程产物位置：dev 走 Vite server，prod 走 dist/index.html。 */
function rendererFile(): string {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

function preloadFile(): string {
  return path.join(__dirname, 'preload.js');
}

/**
 * 数据目录。
 * ★ spec §9.1：目录名固定 Clipchan（%APPDATA%\\Clipchan），旧用户的历史原地可迁移。
 * ★ smoke 模式改用临时目录，绝不碰用户的真实历史。
 */
function setupDataDir(): string {
  if (SMOKE) {
    const tmp = path.join(app.getPath('temp'), 'clipchan-smoke-' + process.pid);
    app.setPath('userData', tmp);
    return tmp;
  }
  const dir = resolveDataDir(app.getPath('appData'));
  app.setPath('userData', dir);
  return dir;
}

/**
 * 注册 `clipchan-img:` 协议处理器（★ 必须在 app ready 之后调用）。
 *
 * 只服务 `clipchan-img://thumb/thumbs/<file>`，实际文件从 <dataDir>/thumbs 读；
 * 路径穿越、别的 scheme/主机名、目录本身一律 404（判定逻辑在 thumb-url.ts，已单测）。
 * 用 net.fetch(file://) 让 Electron 自己定 MIME 并支持流式读取。
 */
function registerThumbProtocol(dataDir: string): void {
  protocol.handle(THUMB_SCHEME, (request) => {
    const abs = resolveThumbRequest(request.url, dataDir);
    if (!abs || !fs.existsSync(abs)) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return net.fetch(pathToFileURL(abs).toString());
  });
}

/** 建目录、开库、按需迁移、清孤儿。 */
function setupStorage(dataDir: string): { db: Db; migrated: number } {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(imagesDir(dataDir), { recursive: true });
  fs.mkdirSync(thumbsDir(dataDir), { recursive: true });

  const dbPath = dbFile(dataDir);
  const isFresh = !fs.existsSync(dbPath);
  const db = openDb(dbPath);

  const migration = runLegacyMigration(db, dataDir, isFresh);
  const migrated = migration.imported;

  try {
    const orphans = sweepOrphans(dataDir, db.allImageRows(), {
      onLog: (m: string) => console.warn('[images] ' + m),
    });
    if (orphans.length > 0) console.log('[images] 清理孤儿文件 ' + orphans.length + ' 个');
  } catch (e) {
    console.error('[images] 孤儿扫描失败（不阻断启动）：' + String(e));
  }
  return { db, migrated };
}

/**
 * 建立 Task 5/6/8 的运行时服务（助手 / 目标跟踪 / 毛玻璃 / 轮询 / 记录 / 幽灵 / 粘贴）。
 *
 * ★ 顺序有讲究：
 *   1. 助手客户端先建（毛玻璃与目标跟踪都依赖它），但**不预启动**——懒启动由第一次
 *      `blur()` / `paste()` / `foreground()` 触发，启动后助手自己会空闲 5 秒预热；
 *   2. 轮询器必须**先 baseline() 再 start()**：否则启动前就躺在剪贴板里的内容会被
 *      记成一条历史（验收 27，spec §7.1）。
 *
 * ★ 助手不可用（exe 不存在 / 编译失败）时全链路诚实降级：
 *   autoPaste 与 frostedGlass 均为 false，粘贴仍把内容写进剪贴板并提示手动粘贴。
 */
function setupServices(dataDir: string): void {
  const db = rt.db;
  if (!db) return;

  // ★ 打包后助手由 extraResources 放在 resources 根下（不是开发期的 helper/dist）；
  //   helper.ts 刻意不 import electron，所以这条分支判断留在主进程里。
  helperClient = new HelperClient({
    exePath: app.isPackaged ? packagedHelperExePath(process.resourcesPath) : defaultHelperExePath(),
  });
  tracker = new TargetTracker({ foreground: helperClient });
  frosted = new FrostedGlass({ helper: helperClient });

  const recorder = new Recorder({
    db,
    clip: clipboard,
    dataDir,
    settings: () => rt.settings ?? DEFAULT_SETTINGS,
    onLog: (m: string) => console.warn('[recorder] ' + m),
  });

  mergeSvc = new MergeService({ db });
  burstDetector = new BurstDetector();

  // ★ 连续复制检测与面板刷新都挂在"记录成功"这一刻：Recorder 没有回调，
  // 所以这里包一层 sink 转发 lastSeen，并在拿到 InsertResult 后做后处理。
  const sink: RecordSink = {
    get lastSeen() {
      return recorder.lastSeen;
    },
    recordText: (text: string) => afterRecord(recorder.recordText(text)),
    recordImage: (img) => afterRecord(recorder.recordImage(img)),
  };

  watcher = new ClipboardWatcher({
    clip: clipboard,
    recorder: sink,
    isGhostActive: () => ghostSvc?.isActive() ?? false,
    onNotice: (_kind, message) => makeBroadcaster(() => rt.win).toast(message, 'info'),
  });

  ghostSvc = new Ghost({
    watcher,
    recorder,
    onChange: (state) => {
      rt.ghost = state;
      makeBroadcaster(() => rt.win).ghostChanged(state);
    },
    // ★ 恢复提示由 core 的 store 统一发（store.ts:410/501），主进程再发会重复。
  });

  pasteSvc = new PasteService({
    db,
    helper: helperClient,
    tracker,
    // ★ 传取值函数而不是快照：设置页改了开关必须立刻生效（旧实现传对象，改完要重启）。
    getSettings: () => ({ autoPaste: rt.settings?.autoPaste ?? true }),
    writer: {
      // ★ 自我抑制：程序自己写剪贴板之前先立标记，下一跳只更新"上次值"不入库。
      writeText: (text: string) => {
        watcher?.suppressNext();
        clipboard.writeText(text);
      },
      writeImage: (bytes: Buffer) => {
        watcher?.suppressNext();
        clipboard.writeImage(nativeImage.createFromBuffer(bytes));
      },
    },
    dataDir,
  });

  recorder.baseline();
  watcher.start();
}

/**
 * 是否启用系统级模糊（DWM acrylic）。
 *
 * ★ 已关闭，原因（真机六组探针实测）：Win10 19045 上 SetWindowCompositionAttribute 的
 *   模糊层**铺满整个 HWND 矩形**，Electron 的 setShape(SetWindowRgn) 裁不掉它 ——
 *   圆角外会露出一圈浅灰白，就是用户报的「四边不光滑、有白色突出」。
 *   关掉系统模糊后窗口圆角由 setShape 负责，圆角外真的没有像素，四边干净。
 *   助手仍然保留 BLUR 能力（将来系统支持圆角模糊时把这里改回 true 即可）。
 */
const ENABLE_SYSTEM_BLUR = false;

/** 显示/隐藏面板时同步系统模糊（spec §6.6；当前关闭，见 ENABLE_SYSTEM_BLUR）。 */
async function applyFrosted(enabled: boolean): Promise<void> {
  if (!ENABLE_SYSTEM_BLUR) return;
  if (!frosted || !rt.win || rt.win.isDestroyed()) return;
  const ok = await frosted.apply(rt.win, enabled);
  // 诊断留痕：真毛玻璃是本项目最容易"看起来成了其实没成"的一环，必须能看到结果。
  // 注意 enabled=false 时返回 false 是**预期**（表示"当前没有开毛玻璃"），不是失败。
  if (enabled) {
    console.log('[frosted] 应用 ok=' + ok + ' supported=' + frosted.supported);
  } else if (!ok) {
    console.log('[frosted] 已关闭');
  }
}

/** 面板当前的自身窗口句柄（目标跟踪要拿它把"自己"排除掉）。 */
function selfHwnd(): number {
  return rt.win && !rt.win.isDestroyed() ? handleOf(rt.win) : 0;
}

/**
 * 组装 IPC 处理器表。
 * ★ Task 4 只接"存储层已能支撑"的通道；paste / mergeSelected / ghost / wordcloud
 *   仍留给 Task 5/6/9 —— 未实现的一律由 ipc.ts 抛 not-implemented，绝不假装成功。
 */
function buildHandlers(): Partial<Record<string, IpcHandler>> {
  const broadcast = makeBroadcaster(() => rt.win);
  aiBroadcast = broadcast;
  const needDb = (): Db => {
    if (!rt.db) throw new Error('数据库尚未就绪');
    return rt.db;
  };
  const needSettings = (): Settings => {
    if (!rt.settings) throw new Error('设置尚未就绪');
    return rt.settings;
  };

  const handlers: Partial<Record<string, IpcHandler>> = {
    // ★ 库里存的是相对路径（spec §9.2），渲染进程的 <img> 认不了；在 IPC 边界翻成
    //   clipchan-img://thumb/... 协议 URL，磁盘路径仍不出主进程。
    [CH.items.list]: (_e, q) => needDb().list(q ?? {}).map(mapThumbUrl),
    [CH.items.paste]: (_e, id: string) => {
      // ★ 粘贴会改 created_at/seq（刚用过的排最前），完成后必须广播刷新列表。
      const svc = pasteSvc;
      if (!svc) return { ok: false, reason: 'send-failed' };
      return Promise.resolve(svc.pasteItem(String(id))).then((result) => {
        broadcast.itemsChanged();
        return result;
      });
    },
    [CH.items.remove]: (_e, id: string) => {
      const { log } = removeItemsWithFiles(needDb(), rt.dataDir, [String(id)], (m) => console.warn('[images] ' + m));
      if (log.failures.length > 0) broadcast.toast('记录已删除，但有 ' + log.failures.length + ' 个图片文件未能删除', 'warn');
      broadcast.itemsChanged();
    },
    [CH.items.togglePin]: (_e, id: string) => {
      needDb().togglePin(String(id));
      broadcast.itemsChanged();
    },
    [CH.items.clearUnpinned]: () => {
      const { removed, log } = clearUnpinnedWithFiles(needDb(), rt.dataDir, (m) => console.warn('[images] ' + m));
      if (log.failures.length > 0) broadcast.toast('已清空，但有 ' + log.failures.length + ' 个图片文件未能删除', 'warn');
      broadcast.itemsChanged();
      return removed;
    },
    [CH.items.clearAll]: () => {
      // ★ 先记下所有图片行、删库、再删文件 —— 顺序反了就拿不到相对路径了。
      const rels: string[] = [];
      for (const r of needDb().allImageRows()) {
        if (r.image_path) rels.push(r.image_path);
        if (r.thumb_path) rels.push(r.thumb_path);
      }
      const removed = needDb().clearAll();
      const { log } = deleteImageFiles(rt.dataDir, rels, (m) => console.warn('[images] ' + m));
      if (log.failures.length > 0) broadcast.toast('已清空，但有 ' + log.failures.length + ' 个图片文件未能删除', 'warn');
      broadcast.itemsChanged();
      return removed;
    },
    [CH.items.getFullImage]: (_e, id: string) => {
      const row = needDb().getImageRow(String(id));
      if (!row || !row.image_path) return '';
      const abs = imageAbs(rt.dataDir, row.image_path);
      return fs.existsSync(abs) ? abs : '';
    },
    [CH.ghost.get]: () => ghostSvc?.get() ?? rt.ghost,
    [CH.ghost.set]: (_e, minutes: number | null) => {
      // ★ 幽灵模式：彻底停止轮询（不是"读了再丢"），恢复时静默重置基线、不补录。
      const next = ghostSvc?.set(minutes ?? null) ?? rt.ghost;
      rt.ghost = next;
      return next;
    },
    [CH.settings.get]: () => needSettings(),
    [CH.settings.set]: (_e, patch: Partial<Settings>) => {
      const next = needDb().setSettings(patch ?? {});
      rt.settings = next;
      // 历史上限变了要立刻收敛（spec §7.5 / §9.2 的 Trim 语义）。
      if (patch && typeof patch.historyLimit === 'number') needDb().list({ limit: 1 });
      // 图片预算变了要立刻淘汰（spec §7.3）。
      if (patch && typeof patch.imageBudgetMB === 'number') {
        enforceImageBudget(needDb(), rt.dataDir, Math.max(0, patch.imageBudgetMB) * 1024 * 1024, (m) =>
          console.warn('[images] ' + m)
        );
      }
      if (patch && (typeof patch.hotkeyActivate === 'string' || typeof patch.hotkeyWidget === 'string')) {
        registerHotkeysNow();
      }
      // ★ 小组件宽度：真正改窗口尺寸的是 app.setWidgetSize（它会 applyMode），
      //   这里只保证渲染进程拿到最新设置（store 的 settings.onChanged 会同步 store）。
      if (patch && typeof patch.widgetSize === 'number') {
        if (rt.mode === 'widget' && rt.win && !rt.win.isDestroyed()) {
          applyMode(rt.win, 'widget', next.widgetSize);
        }
      }
      broadcast.settingsChanged(next);
      broadcast.itemsChanged();
      return next;
    },
    [CH.app.setMode]: (_e, mode: WinMode) => {
      void switchMode(mode === 'widget' ? 'widget' : 'main');
    },
    [CH.app.hide]: () => {
      rt.win?.hide();
    },
    [CH.app.setWidgetSize]: (_e, px: number) => {
      const size = Math.round(Number(px) || 280);
      const next = needDb().setSettings({ widgetSize: size });
      rt.settings = next;
      if (rt.mode === 'widget') applyMode(needWin(), 'widget', size);
      broadcast.settingsChanged(next);
    },
    // 小组件按内容自适应高度（用户反馈「小组件有一大部分是空白」）。
    [CH.app.setWidgetHeight]: (_e, px: number) => {
      if (rt.mode !== 'widget') return;
      setWidgetHeight(needWin(), Number(px) || 420);
    },
    [CH.app.resizeBy]: (_e, dw: number, dh: number, shape?: boolean) => {
      resizeBy(needWin(), Number(dw) || 0, Number(dh) || 0, rt.mode, shape !== false);
    },
    [CH.app.getHotkeyStatus]: () => rt.hotkeyStatus,
    [CH.app.getAutoStart]: () => getAutoStartNow(),
    [CH.app.setAutoStart]: (_e, on: boolean) => setAutoStartNow(Boolean(on)),
    [CH.app.openDataFolder]: () => {
      void import('electron').then((m) => m.shell.openPath(rt.dataDir));
    },
    // 拼接选中项（spec §7.5：跳过收藏项，源条目被新记录取代）。
    [CH.items.mergeSelected]: (_e, ids: string[]) => {
      const svc2 = mergeSvc;
      if (!svc2) return { ok: false, reason: 'not-enough' };
      const list = Array.isArray(ids) ? ids.map((id) => String(id)) : [];
      const result = svc2.mergeSelected(list);
      if (result.ok) {
        // 合并成功即这一串连续复制已经落地成一条，提示条与预选一起收掉。
        burstDetector?.clear();
        pendingBurstIds = [];
        broadcast.itemsChanged();
      }
      return result;
    },
    [CH.wordcloud.today]: () => {
      const wdb = rt.db;
      if (!wdb) return { words: [], totalItems: 0 };
      return wordCloudToday(wdb);
    },
    [CH.wordcloud.exportPng]: () => exportWordCloudPng(),
    // ★ AI 面（Task 5）：Key 只在主进程与库之间流动，界面拿到的是掩码与布尔。
    ...needAi().handlers(),
  };
  return handlers;
}

function needAi(): AiApi {
  if (!aiApi) throw new Error('AI 桥尚未就绪');
  return aiApi;
}

function needWin(): BrowserWindow {
  if (!rt.win) throw new Error('窗口尚未创建');
  return rt.win;
}

/**
 * 切换窗口形态（主面板 ↔ 小组件）。
 *
 * ★ 显示面板前必须先记下"唤起那一刻"的前台窗口 —— 这是自动粘贴的目标来源，
 *   而且要**在 show() 之前**查，否则查到的就是面板自己（spec §7.2）。
 */
async function switchMode(mode: WinMode): Promise<void> {
  rt.mode = mode;
  if (rt.win && !rt.win.isDestroyed()) {
    const self = handleOf(rt.win);
    // ★ 必须**先查到前台窗口、再 show()**，而且要等查询结果回来。
    //   实测 bug：之前是 `void tracker.notePanelShown(self)` 后立刻 show/focus，
    //   助手处理 FG 时面板已经在前台 → 查到的是自己 → 被丢弃 → 自动粘贴的目标是旧句柄。
    //   这里用 120ms 上限兜住"助手卡死"的情形：超时只是没拿到目标（诚实回退成
    //   "已复制，按 Ctrl+V 粘贴"），绝不拖慢面板唤起（验收 25 要求 <300ms）。
    if (tracker) await Promise.race([tracker.notePanelShown(self), delay(120)]);
    applyMode(rt.win, mode, rt.settings?.widgetSize);
    rt.win.show();
    rt.win.focus();
    void applyFrosted(true);
  }
}

/** 简单的毫秒延时（用于给前台查询设上限）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerHotkeysNow(): void {
  const settings = rt.settings;
  if (!settings) return;
  rt.hotkeyStatus = registerHotkeys(settings, {
    onActivate: () => {
      void switchMode('main');
      navigateTo('list');
    },
    onWidget: () => void switchMode('widget'),
  });
}

/** electron 的登录项 API → autostart.ts 期望的依赖形状（只这一处适配）。 */
function autoStartDeps() {
  return {
    getLoginItemSettings: (opts?: { path?: string }) => app.getLoginItemSettings(opts as never),
    setLoginItemSettings: (opts: { openAtLogin: boolean; path?: string; args?: string[] }) =>
      app.setLoginItemSettings(opts as never),
  };
}

function getAutoStartNow(): boolean {
  const r = readAutoStart(autoStartDeps(), process.env, process.execPath);
  rt.autoStart = r.ok;
  return rt.autoStart;
}

function setAutoStartNow(on: boolean): boolean {
  const r = ensureAutoStart(on, autoStartDeps(), process.env, process.execPath);
  rt.autoStart = getAutoStartNow();
  return r.ok;
}

/**
 * 系统能力（渲染进程在 preload 阶段同步取一次，界面据此显示"已启用/已降级"）。
 *
 * ★ 诚实原则（Global Constraints「不假装」）：
 * - `autoPaste`：既要有助手、又要在设置里打开「Enter 自动粘贴」；
 * - `frostedGlass`：以 `FrostedGlass.supported` 为准 —— 只有**真的成功过一次**
 *   DWM 磨砂才算支持，助手缺失或系统拒绝都如实显示「已降级」；
 * - `backgroundCapture`：轮询器已启动即 true（幽灵模式是临时状态，不改能力）。
 */
function capabilitiesOf(): Capabilities {
  return {
    autoPaste: (helperClient?.available ?? false) && (rt.settings?.autoPaste ?? false),
    globalHotkey: rt.hotkeyStatus.activate || rt.hotkeyStatus.widget,
    backgroundCapture: watcher?.isRunning() ?? false,
    // ★ 如实报 false：系统模糊已关闭（它会盖住圆角，见 ENABLE_SYSTEM_BLUR），
    //   界面据此显示「半透明」而不是假装「已启用」。
    frostedGlass: ENABLE_SYSTEM_BLUR ? (frosted?.supported ?? false) : false,
  };
}

/** 托盘菜单回调（buildTrayNow 与 rebuildTrayMenu 共用同一份，避免勾选态与行为漂移）。 */
function trayHandlers(): Parameters<typeof buildTrayMenu>[1] {
  return {
    onShowPanel: () => void switchMode('main'),
    onGhost: (minutes) => {
      // 托盘与界面共用同一套幽灵状态机；改完重建菜单让勾选态跟上。
      const next = ghostSvc?.set(minutes) ?? rt.ghost;
      rt.ghost = next;
      makeBroadcaster(() => rt.win).ghostChanged(next);
      rebuildTrayMenu();
    },
    onToggleAutoPaste: (on) => {
      if (!rt.db) return;
      rt.settings = rt.db.setSettings({ autoPaste: on });
      makeBroadcaster(() => rt.win).settingsChanged(rt.settings);
      rebuildTrayMenu();
    },
    onToggleAutoStart: (on) => {
      setAutoStartNow(on);
      rebuildTrayMenu();
    },
    onOpenSettings: () => {
      void switchMode('main');
      navigateTo('settings');
    },
    onQuit: () => {
      app.quit();
    },
  };
}

function buildTrayNow(): void {
  const iconPath = defaultTrayIcon(process.resourcesPath, app.isPackaged, assetPath());
  rt.tray = createTray(iconPath, trayState(), trayHandlers());
}

/** 托盘勾选态（幽灵剩余时长 / 自动粘贴 / 自启）变了之后重建菜单。 */
function rebuildTrayMenu(): void {
  if (!rt.tray) return;
  try {
    rt.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(trayState(), trayHandlers())));
  } catch {
    /* 托盘已销毁：不影响主流程 */
  }
}

function trayState() {
  return {
    ghost: rt.ghost,
    settings: rt.settings ?? ({ autoPaste: true } as Settings),
    autoStart: rt.autoStart,
  };
}

/** 冒烟：建窗 → 回读尺寸 → 切小组件 → 回读 → 汇总 JSON。 */
async function runSmoke(): Promise<void> {
  const win = rt.win;
  const result: Record<string, unknown> = {
    windowCreated: !!win,
    modeSizes: {} as Record<string, number[]>,
    hotkeys: rt.hotkeyStatus,
    trayItems: trayLabels(buildTrayMenu(trayState(), {} as never)),
    ipcChannels: registeredChannels().length,
    capabilities: capabilitiesOf(),
    dataDir: rt.dataDir,
  };

  if (win) {
    const sizes = result.modeSizes as Record<string, number[]>;
    const bounds: Record<string, unknown> = {};
    applyMode(win, 'main');
    sizes.main = win.getSize();
    bounds.main = win.getBounds();
    applyMode(win, 'widget', 280);
    sizes.widget = win.getSize();
    bounds.widget = win.getBounds();
    applyMode(win, 'main');
    sizes.backToMain = win.getSize();
    bounds.backToMain = win.getBounds();
    result.modeBounds = bounds;
    // 窗口必须落在鼠标所在那块显示器内（spec §6.6：唤起时出现在鼠标那块屏）。
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    result.cursorDisplay = { id: display.id, bounds: display.bounds, workArea: display.workArea };
    result.frostedGlass = frosted?.supported ?? false;
  }

  const line = 'SMOKE ' + JSON.stringify(result);
  console.log(line);
  try {
    fs.writeFileSync(path.join(__dirname, 'smoke-result.json'), line, 'utf8');
  } catch {
    /* 写不了文件也不影响 stdout 通道 */
  }
  unregisterHotkeys();
  app.exit(0);
}

// ---------------- 启动 ----------------

function main(): void {
  const first = enforceSingleInstance({
    requestLock: () => app.requestSingleInstanceLock(),
    onSecondInstance: () => {
      if (rt.win && !rt.win.isDestroyed()) {
        rt.win.show();
        rt.win.focus();
      }
    },
    quit: () => app.quit(),
  });
  if (!first) return;

  app.on('second-instance', () => {
    if (rt.win && !rt.win.isDestroyed()) {
      void switchMode('main');
    }
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：关掉面板不退出应用（spec §6.3）。
    if (SMOKE) app.quit();
  });

  void app.whenReady().then(() => {
    rt.dataDir = setupDataDir();
    // ★ 协议处理器必须在 ready 之后注册（registerSchemesAsPrivileged 已在上面的模块作用域执行）。
    registerThumbProtocol(rt.dataDir);
    const { db } = setupStorage(rt.dataDir);
    rt.db = db;
    rt.settings = db.getSettings();

    // ★ smoke 只验骨架，不碰真实剪贴板，也不启动助手（保持冒烟又快又干净）。
    if (!SMOKE) setupServices(rt.dataDir);

    // ★ 必须早于 buildHandlers()：处理器表里要展开 needAi().handlers()。
    aiApi = buildAiApi(() => aiBroadcast);
    registerIpc({ handlers: buildHandlers(), capabilities: capabilitiesOf });

    rt.win = createMainWindow({
      mode: rt.mode,
      show: !SMOKE,
      preload: preloadFile(),
      devServerUrl: SMOKE ? undefined : process.env.VITE_DEV_SERVER_URL,
      // smoke 时加载 build-main.mjs 写的占位页，保证窗口真的有内容可加载。
      file: SMOKE ? path.join(__dirname, 'smoke.html') : rendererFile(),
      widgetSize: rt.settings.widgetSize,
      // ★ 非 smoke 一律延迟显示：渲染进程在 preload 阶段用 sendSync 取一次
      // capabilities，真毛玻璃必须先应用好再加载页面，否则界面永远显示"已降级"。
      defer: !SMOKE,
    });
    rt.win.on('closed', () => {
      rt.win = null;
    });

    // ★ 显示时开真毛玻璃、隐藏时关掉（spec §6.6）。
    // 首次显示已经在上面的 defer 流程里应用过毛玻璃，这里只做"丢了再补"的兜底。
    rt.win.on('show', () => {
    flushPendingBurst();
      if (!frosted?.active) void applyFrosted(true);
    });
    rt.win.on('hide', () => void applyFrosted(false));

    /**
     * 失焦：记一次"外部前台窗口"（小组件常驻 / 关掉失焦隐藏时，粘贴目标靠它兜底），
     * 并在小组件形态按设置自动隐藏（spec §6.6 第 7 条，验收 29）。
     * ★ 主面板形态**不**自动隐藏：用户正在里面挑东西，失焦就消失会很烦人。
     */
    rt.win.on('blur', () => {
      const self = selfHwnd();
      if (tracker) void tracker.notePanelShown(self);
      if (rt.mode === 'widget' && (rt.settings?.hideOnBlur ?? true)) {
        void applyFrosted(false);
        rt.win?.hide();
      }
    });
    if (rt.mode === 'widget') applyMode(rt.win, 'widget', rt.settings.widgetSize);

    // ★ 顺序铁律（Task 8）：先应用真毛玻璃，再显示并加载页面。
    // preload 的 sendSync(capabilities) 发生在加载页面时，此刻 frosted.supported 必须已是真值。
    if (!SMOKE) {
      void applyFrosted(true).then(() => {
        if (rt.win && !rt.win.isDestroyed()) {
          loadRenderer(rt.win, {
            show: true,
            devServerUrl: process.env.VITE_DEV_SERVER_URL,
            file: rendererFile(),
          });
        }
      });
    }

    registerHotkeysNow();
    getAutoStartNow();
    if (!SMOKE) buildTrayNow();

    if (SMOKE) {
      void runSmoke();
      return;
    }
    console.log(
      '[main] 数据目录 ' + rt.dataDir +
      '，自启目标 ' + autoStartPath(process.env, process.execPath) +
      '，快捷键 activate=' + rt.hotkeyStatus.activate + ' widget=' + rt.hotkeyStatus.widget
    );
  });
}

app.on('will-quit', () => {
  // ★ 第二实例拿不到单实例锁时会走 app.quit()，此时 app 还没 ready，
  //   globalShortcut.unregisterAll() 会抛「cannot be used before the app is ready」
  //   并弹出主进程 JS 错误框（真机实测：双击第二次 exe 必现）。
  if (app.isReady()) unregisterHotkeys();
  // 收口：停轮询 → 关幽灵定时器 → 发 QUIT 让助手进程自己退出（2 秒后强杀兜底）。
  watcher?.stop();
  ghostSvc?.dispose();
  void helperClient?.dispose();
});

main();
