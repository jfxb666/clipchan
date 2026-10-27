/**
 * Electron 主进程入口。
 *
 * ★ Task 4 的职责：把窗口、托盘、热键、单实例、自启、IPC 骨架立起来。
 * ★ Task 5/6/9 会往 `buildHandlers()` 里继续填 items.paste / ghost / wordcloud —— 本文件
 *   用"处理器表"而不是散落的 ipcMain.handle，正是为了让那些任务只改一处。
 * ★ --smoke：创建窗口、切两次形态、回读尺寸、打印一行 SMOKE {...} 后退出 0
 *   （给 scripts/smoke-main.mjs 断言用，不需要人眼看）。
 */
import { Menu, app, BrowserWindow, clipboard, desktopCapturer, dialog, nativeImage, net, protocol, safeStorage, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeUrl, pasteHintOf } from '@clipchan/core';
import type {
  Capabilities,
  CaptureFinishPayload,
  CaptureResult,
  CaptureTarget,
  FolderInput,
  GhostState,
  ListQuery,
  NavigateTarget,
  OptimizeRequest,
  OptimizeResult,
  Settings,
  SnippetInput,
  UpdateStatus,
} from '@clipchan/core';
import { adapterFor } from '@clipchan/ai';
import { assist as runAssist, optimize as runOptimize } from '@clipchan/ai';
import { CH, EV } from './channels';
import { PROVIDERS_KEY, createAi } from './ai';
import { createElectronSecretCrypto, createSecretBox } from './keyvault';
import { DEFAULT_BACKUP_INTERVAL_MS, DEFAULT_BACKUP_KEEP } from './backup';
import { maybeBackup, recoverCorruptDb } from './storage-guard';
import { createDeltaThrottle } from './deltaThrottle';
import type { AiApi } from './ai';
import Database from 'better-sqlite3';
import { openDb } from './db';
import type { Db, InsertResult } from './db';
import { runLegacyMigration } from './migrate-runner';
import { createLogSink, installCrashHooks } from './logs';
import { deleteImageFiles, enforceImageBudget, hashImageBuffer, imagePhash, purgeItemsWithFiles, purgeTrashOverLimitWithFiles, saveImage } from './images';
import type { NativeImageLike, SavedImage } from './images';
import { sweepOrphans } from './images-policy';
import { DB_FILE_NAME, backupsDir, imageAbs, imagesDir, logsDir, thumbsDir, dbFile, resolveDataDir, toRelativePath } from './paths';
import { THUMB_SCHEME, imageUrlFor, mapThumbUrl, resolveImageRequest, resolveThumbRequest } from './thumb-url';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { exportAllToZip, importAllFromZip, importSummaryText } from './export-import';
import { makeBroadcaster, registerIpc, registeredChannels, runRestore } from './ipc';
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
import { describeFinish, matchSource, thumbnailSizeFor } from './capture';
import { closeOverlays, createOverlayWindows } from './overlay';
import { createOcr, upscaleSize } from './ocr';
import type { OcrApi } from './ocr';
import { createQr } from './qrcode';
import type { QrApi } from './qrcode';
import { createUrlMeta } from './url-meta';
import type { UrlMetaApi } from './url-meta';
import type { RecordSink } from './watcher';
import { DRAG_HINT_NO_FILE, dragHintFor, dragPayloadFor } from './dragout';
import { buildDropFiles } from './dropfiles';
import { Updater } from './updater';

const SMOKE = process.argv.includes('--smoke');
/** 定期备份的轮询间隔：1 小时轮询、24 小时才真备份一次（原因见 whenReady 里的注释）。 */
const BACKUP_POLL_MS = 60 * 60 * 1000;
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
  hotkeyStatus: { activate: boolean; widget: boolean; capture: boolean; conflicts: string[] };
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
  hotkeyStatus: { activate: false, widget: false, capture: false, conflicts: [] },
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
/** 自动更新（P0-3）。开发环境整体禁用，见构造处注释。 */
let updater: Updater | null = null;

/**
 * 文件日志槽。
 * ★ 放模块级而不是塞进 Runtime：崩溃钩子在 app ready 之前就要能写，而 Runtime 那时还是空壳。
 * ★ 打包后用户看不到控制台，26 处 warn/error 等于全丢；落盘才能让「导出日志」有意义。
 */
let logSink: ReturnType<typeof createLogSink> | null = null;
/**
 * 本次启动是否从损坏的库里恢复过（值是备份文件名）。
 * ★ 存模块级是因为 setupStorage 跑在窗口创建之前，那时没有 win 可以弹 toast；
 *   等 did-finish-load 之后再补发一条，用户才知道自己的历史去哪了。
 */
let recoveredFromDb: string | null = null;
/**
 * 本次启动是否成功从备份恢复过（值是备份文件名）。
 * ★ 和 recoveredFromDb 分开存：一个是"数据救回来了"，一个是"数据没救回来、只留了档"，
 *   提示语和严重级别完全不同，混成一个变量必然把好消息说成坏消息。
 */
let restoredFromDb: string | null = null;

/** 控制台 + 文件双写。★ 控制台留着是因为开发期 console 更好用，落盘是给用户看的。 */
function logLine(msg: string): void {
  console.log(msg);
  logSink?.write(msg);
}

function logWarn(msg: string): void {
  console.warn(msg);
  logSink?.write('[warn] ' + msg);
}

function logError(msg: string): void {
  console.error(msg);
  logSink?.write('[error] ' + msg);
}

/**
 * 一次截图会话的两个句柄：overlay 窗与它们各自的底图。
 * ★ 底图留在主进程而不是随窗传：overlay 只拿自己那块（capture.target 按 displayId 取），
 *   否则多屏时每个窗都会收到全部屏的 PNG，内存与 IPC 都白付一遍。
 */
let captureOverlays: BrowserWindow[] = [];
let captureTargets: CaptureTarget[] = [];
/**
 * 抓屏进行中标记。
 * ★ captureOverlays 要等 await getSources 之后才赋值，光靠它当守卫挡不住连按：
 *   每次调用都在赋值之前就穿过去了，屏幕上会叠出好几层全屏窗。
 */
let captureStarting = false;

/** 广播器在 buildHandlers() 里才创建；AI 桥用它的 aiChanged 通道。 */
let aiBroadcast: {
  aiChanged(): void;
  aiOptimizeDelta(requestId: string, text: string): void;
} = { aiChanged: () => {}, aiOptimizeDelta: () => {} };

/** 流式增量节流器（节流 + 尾巴投影的规则全在 deltaThrottle.ts，那里可测）。 */
const deltaThrottle = createDeltaThrottle({
  send: (requestId, tail) => aiBroadcast.aiOptimizeDelta(requestId, tail),
});

/**
 * 把 Electron 的 safeStorage 适配成 keyvault 的 SafeStorageLike。
 *
 * ★ 为什么不直接传 safeStorage：Electron 37 的 decryptString 返回 **string**，
 *   而 SafeStorageLike 约定返回字节（Uint8Array）—— 直接传过不了类型检查。
 *   这里按 utf8 编回去，语义与 keyvault 内部 Buffer.from(...).toString('utf8') 完全一致。
 * ★ 每次调用都现取 safeStorage 的方法，不在模块加载期缓存：缓存住的是未就绪状态。
 */
function electronSecretCrypto(): ReturnType<typeof createElectronSecretCrypto> {
  return createElectronSecretCrypto({
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain: string) => safeStorage.encryptString(plain),
    decryptString: (encrypted: Uint8Array) => Buffer.from(safeStorage.decryptString(Buffer.from(encrypted)), 'utf8'),
  });
}

/**
 * AI 桥（Task 5 Step 4）。
 * ★ 这里只做"依赖装配"：kv 从库来、adapterFor/optimize 从 @clipchan/ai 来，
 *   业务逻辑全在 ai.ts 里（那才测得了）。
 */
let aiApi: AiApi | null = null;

function buildAiApi(getBroadcast: () => { aiChanged(): void; aiOptimizeDelta(requestId: string, text: string): void }): AiApi {
  // ★ SecretBox 是惰性的：构造它不会碰 safeStorage，所以本函数在 app ready 之前调也安全。
  // ★ 加密不可用时（Linux 无 keyring / 系统凭据异常）keyvault 自动降级为 plain:v1: 前缀，
  //   是**诚实降级**而不是静默丢 Key —— 用户至少能看到 Key 还在、并在设置页被提示。
  const secretBox = createSecretBox(electronSecretCrypto());
  return createAi({
    secretBox,
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
    assist: runAssist,
    // ★ Key 变了只发"变了"这一件事，数据让界面自己重取（事件里不带任何 provider 字段）。
    onChanged: () => getBroadcast().aiChanged(),
    // ★ 流式增量：走节流器，过期 requestId 由渲染层自己按 id 丢弃。
    onDelta: (requestId: string, text: string) => deltaThrottle.push(requestId, text),
    onDeltaEnd: (requestId: string) => deltaThrottle.end(requestId),
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
  const broadcast = makeBroadcaster(() => rt.win);
  broadcast.itemsChanged();
  // ★ 只提示、不拦截：图库里有相似图时照常入库（用户复制过两次同一张图是常事，
  //   悄悄丢掉才是数据丢失）。所以这里发的是一条 info toast，而不是"已跳过"。
  // ★ 能走到这里就意味着 touched === false（上面第一行已经挡掉了去重命中）：
  //   那种情况下界面上没有新增行，再弹"已有一张很相似的"只会让用户莫名其妙。
  if (result.similarTo) broadcast.toast('这张图库里已有一张很相似的，已照样保存', 'info');
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
    // ★ 同一个 scheme 两个 host：thumb 读 thumbs/，image 读 images/，各自白名单独立。
    const abs =
      resolveThumbRequest(request.url, dataDir) ?? resolveImageRequest(request.url, dataDir);
    if (!abs || !fs.existsSync(abs)) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return net.fetch(pathToFileURL(abs).toString());
  });
}

/**
 * 判断库文件是否已损坏（只读预检）。
 *
 * ★ 为什么"先探一遍"而不是"openDb 抛错后再改名"：Windows 上 better-sqlite3 打开失败时
 *   句柄仍然被持有（openDb 内部没有 close），此时 rename 直接 EBUSY，备份根本做不成。
 *   自己开一次、查完立刻 close，句柄不泄漏，后面改名才稳（实测 5/5 成功）。
 * ★ 只跑 quick_check：integrity_check 在几十万条的库上要几秒，启动路径花不起。
 */
function dbLooksCorrupt(file: string): boolean {
  // new Database 遇到不存在的文件会顺手建一个空库，所以先短路。
  if (!fs.existsSync(file)) return false;
  let probe: Database.Database | null = null;
  try {
    probe = new Database(file);
    const rows: unknown = probe.pragma('quick_check');
    const first = Array.isArray(rows) && rows.length > 0 ? Object.values(rows[0] as object)[0] : null;
    // 健康库返回 [{quick_check:'ok'}]；损坏时返回第一条具体错误文本。
    return typeof first === 'string' && first.toLowerCase() !== 'ok';
  } catch (e) {
    // 连打开都失败（无 SQLite 魔数 / 页头损坏）也是坏库。
    logWarn('[db] 预检未通过，判定为损坏：' + (e instanceof Error ? e.message : String(e)));
    return true;
  } finally {
    try {
      probe?.close();
    } catch {
      /* 关不掉不影响后续改名：句柄随函数作用域释放 */
    }
  }
}

/**
 * 把坏库改名留档，返回备份文件名（不含目录）。调用方保证此时没有句柄持有它。
 *
 * ★ sidecar 必须跟着一起挪：只备份主库的话，新库启动会去回放旧的 -wal，立刻又坏一次。
 */
function backupCorruptDb(dbPath: string, dataDir: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = DB_FILE_NAME.replace(/\.db$/, '') + '.corrupt-' + stamp + '.db';
  const target = path.join(dataDir, name);
  fs.renameSync(dbPath, target);
  for (const ext of ['-wal', '-shm']) {
    const side = dbPath + ext;
    if (!fs.existsSync(side)) continue;
    try {
      fs.renameSync(side, target + ext);
    } catch {
      // 挪不走就删：留着它会让新库读到旧 WAL，比丢一份无用 sidecar 危险得多。
      try {
        fs.rmSync(side, { force: true });
      } catch {
        /* 真删不掉也继续，openDb 会给出明确的错误 */
      }
    }
  }
  return name;
}

/** 建目录、开库、按需迁移、清孤儿、启动自检备份。 */
function setupStorage(dataDir: string): {
  db: Db;
  migrated: number;
  /** 坏库留档文件名（数据没救回来时的产物）。 */
  recoveredFrom?: string;
  /** 成功恢复所用的备份文件名（数据救回来了）。 */
  restoredFrom?: string;
  /** 本次启动自检备份的绝对路径（做了才 set）。 */
  backupPath?: string;
} {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(imagesDir(dataDir), { recursive: true });
  fs.mkdirSync(thumbsDir(dataDir), { recursive: true });

  const dbPath = dbFile(dataDir);
  // ★ 判定与改名仍是本文件的两个函数（口径要和 openDb 一致，且 sidecar 必须一起挪），
  //   决策顺序在 storage-guard.ts 里，那里能单测。
  const recovery = recoverCorruptDb({
    dataDir,
    dbPath,
    looksCorrupt: dbLooksCorrupt,
    quarantine: backupCorruptDb,
  });
  const recoveredFrom = recovery.quarantinedFrom;
  const restoredFrom = recovery.restoredFrom;
  if (restoredFrom !== undefined) {
    logLine('[db] 历史库损坏，已从备份恢复 ' + restoredFrom);
  } else if (recoveredFrom !== undefined) {
    if (recovery.restoreFailure !== undefined && recovery.restoreFailure !== 'no-backup') {
      logError('[db] 历史库损坏，恢复失败(' + recovery.restoreFailure + ')，已备份为 ' + recoveredFrom + '，将新建空库');
    } else {
      logError('[db] 历史库损坏，已备份为 ' + recoveredFrom + '，将新建空库');
    }
  }
  // ★ 恢复之后必须当成"全新库"：否则 runLegacyMigration 会因为"文件已存在"跳过，
  //   用户的 history.json 就再没机会导进新库了。
  // ★ 这个判定依赖恢复路径的副作用，别改成「用 recoveredFrom/restoredFrom 推」：
  //   恢复成功 → dbPath 存在 → isFresh=false（库里有用户数据）；
  //   走兜底 → dbPath 已被挪走 → isFresh=true。
  const isFresh = !fs.existsSync(dbPath);
  const db = openDb(dbPath);

  const migration = runLegacyMigration(db, dataDir, isFresh);
  const migrated = migration.imported;

  try {
    const orphans = sweepOrphans(dataDir, db.allImageRows(), {
      onLog: (m: string) => logWarn('[images] ' + m),
    });
    if (orphans.length > 0) logLine('[images] 清理孤儿文件 ' + orphans.length + ' 个');
  } catch (e) {
    logError('[images] 孤儿扫描失败（不阻断启动）：' + String(e));
  }

  // ★ 启动自检备份：库已经打开（checkpoint 必须跑在持有写句柄的这条连接上），
  //   且距上次备份超过 24 小时才真做。备份失败只 warn —— 备份是增值功能，
  //   绝不能因为它让用户打不开应用。SMOKE 下也允许跑：它只读+复制，无害。
  const backup = maybeBackup({
    dataDir,
    dbPath,
    // ★ checkpoint 必须跑在持有写句柄的这条连接上，所以走 db.raw（同一个 Database 实例）。
    checkpoint: () => {
      db.raw.pragma('wal_checkpoint(TRUNCATE)');
    },
    intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
    keep: DEFAULT_BACKUP_KEEP,
  });
  let backupPath: string | undefined;
  if (backup.ran) {
    if (backup.result?.ok && backup.result.path) {
      backupPath = backup.result.path;
      logLine('[db] 自动备份 ' + backupPath);
    } else {
      logWarn('[db] 自动备份失败（不阻断启动）：' + (backup.result?.reason ?? '未知原因'));
    }
  }
  return { db, migrated, recoveredFrom, restoredFrom, backupPath };
}

/**
 * 建立 Task 5/6/8 的运行时服务（助手 / 目标跟踪 / 毛玻璃 / 轮询 / 记录 / 幽灵 / 粘贴）。
 *
 * ★ 顺序有讲究：
 *   1. 助手客户端先建（毛玻璃与目标跟踪都依赖它），并**立刻 prewarm 一次**：
 *      冷启动 spawn→READY 实测 427ms，而唤起面板时的目标捕获只有 1s 预算，
 *      不预热就会首次唤起超时（历史上"粘错窗口"的间歇性根因）。prewarm 绝不 await、绝不抛；
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
  // ★ 预热：让首次唤起面板时 FG 查询已是热态（约 16ms 而不是 427ms）。
  //   prewarm 是同步方法且内部已 try/catch，这里再兜一层，绝不让它影响启动流程。
  try {
    helperClient.prewarm();
  } catch (error) {
    logWarn('[helper] 预热失败：' + String(error));
  }
  tracker = new TargetTracker({ foreground: helperClient });
  frosted = new FrostedGlass({ helper: helperClient });

  const recorder = new Recorder({
    db,
    clip: clipboard,
    dataDir,
    settings: () => rt.settings ?? DEFAULT_SETTINGS,
    onLog: (m: string) => logWarn('[recorder] ' + m),
  });

  mergeSvc = new MergeService({ db });
  burstDetector = new BurstDetector();

  // ★ 连续复制检测与面板刷新都挂在"记录成功"这一刻：Recorder 没有回调，
  // 所以这里包一层 sink 转发 lastSeen，并在拿到 InsertResult 后做后处理。
  // ★ sourceApp / richHtml 都是**可选参数**：只写 `(text) => recorder.recordText(text)` 也能
  //   编译通过，于是类型检查全绿、来源与富文本功能却是死的（T5 的坑）。这里必须逐个参数显式转发。
  //   recordFiles 同理 —— 漏掉它就编译不过（RecordSink 把它列为必需），反而是好事。
  const sink: RecordSink = {
    get lastSeen() {
      return recorder.lastSeen;
    },
    recordText: (text: string, sourceApp?: string, richHtml?: string) => {
      const result = afterRecord(recorder.recordText(text, sourceApp, richHtml));
      // ★ 只在文本路径挂链接预览：files/image 的 content 永远不是 URL，
      //   在那里调用只会白跑一次 normalizeUrl。同理 touched 命中的行不需要再抓。
      if (result && !result.touched) prefetchUrlPreview(result.id);
      return result;
    },
    recordImage: (img, sig?: string | null, sourceApp?: string) =>
      afterRecord(recorder.recordImage(img, sig, sourceApp)),
    recordFiles: (paths: string[], sig?: string | null, sourceApp?: string) =>
      afterRecord(recorder.recordFiles(paths, sig, sourceApp)),
  };

  watcher = new ClipboardWatcher({
    clip: clipboard,
    recorder: sink,
    isGhostActive: () => ghostSvc?.isActive() ?? false,
    // ★ 来源应用要靠这条注入才真正接上：不传的话 watcher 里 resolveSourceApp 直接返回
    //   undefined，source_app 永远是 NULL —— 编译通过、功能全死。
    //   助手不可用/超时/前台是 clipchan 自己时 watcher 会归一成 undefined，照常记录。
    foregroundExe: () => helperClient?.foregroundExe() ?? Promise.resolve(null),
    // ★ 传取值函数而不是快照：设置页改了排除列表必须立刻生效（密码管理器留的闸门，
    //   改成快照就等于"重启前一律不生效"）。
    excludeApps: () => rt.settings?.excludeApps ?? [],
    // ★ 文件列表只能问原生助手：Electron 37 读别的程序写的 CF_HDROP 会返回空字节
    //   （has('FileNameW') 为 true，readBuffer() 却是 0 字节），实测同一份剪贴板数据
    //   C# 的 DragQueryFileW 能拿到全部路径。助手不可用时回 null，watcher 会退回 Electron 通道。
    readFiles: () => helperClient?.readFiles() ?? Promise.resolve(null),
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
      // ★ 写文件必须走原生助手。Electron 的 clipboard.writeBuffer('FileNameW', buf) 注册出来的
      //   是**自定义格式**（EnumClipboardFormats 实测 id=49159、名字 FileNameW），根本不是标准
      //   CF_HDROP(15)；资源管理器与 WinForms 的 GetFileDropList() 一律读不到，表现就是
      //   "复制了文件记录但粘贴不出文件"。writeBuffer('CF_HDROP', ...) 同样只注册一个
      //   id=49962 的同名自定义格式。只有助手的 SetClipboardData(15, hGlobal) 是真的。
      // ★ 也绝不能再补一次 clipboard.writeText：写文本会把文件格式整个清掉。
      writeFiles: async (paths: string[]): Promise<boolean> => {
        watcher?.suppressNext();
        const wrote = (await helperClient?.writeFiles(paths)) === true;
        if (wrote) return true;
        // 助手不可用（开发环境没编译 / 被安全软件拦）：退回 Electron 通道。
        // 它写不出标准 CF_HDROP，但至少本程序自己还能读回自己写的自定义格式。
        clipboard.writeBuffer('FileNameW', buildDropFiles(paths));
        return false;
      },
      // ★ 富文本：html 与纯文本一起写，接收方能吃格式就吃格式，吃不了退回纯文本。
      writeRich: (html: string, text: string) => {
        watcher?.suppressNext();
        clipboard.write({ text, html });
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

/**
 * 唤起面板时等待"前台窗口捕获"的兜底上限。
 *
 * ★ 取 300ms 的理由：这一行在 `show()` **之前**，所以它就是"按下热键 → 面板可见"这段
 *   延迟的硬上限，不能超过 spec §7.7 验收 25 的 300ms 可见预算。热态 FG 往返实测 9-18ms，
 *   有 ~16 倍余量，正常路径根本不会触及；只有助手卡死/正在退避重启时才会走到超时分支。
 *   （原先写 1000ms 是为了等冷态 spawn→READY 的 427ms，但 setupServices 里的 prewarm
 *   已经把这条冷路径消掉了 —— 助手崩了的情况下 1s 也救不回来，重启退避是 200→2000ms。）
 * ★ 超时只是"这次没拿到目标"：不动任何槽位（宁可粘错也别丢目标），autoPaste 会诚实
 *   降级成「已复制，按 Ctrl+V 粘贴」。
 */
const PANEL_TARGET_TIMEOUT_MS = 300;

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
    // ★ 纯文本粘贴（Ctrl+Shift+V）：丢掉 text/html 只写纯文本，给"贴到记事本里别带格式"用。
    //   与 items:paste 一样会刷新排序，成功后必须广播。
    [CH.items.pastePlain]: (_e, id: string) => {
      const svc = pasteSvc;
      if (!svc) return { ok: false, reason: 'send-failed' };
      return Promise.resolve(svc.pastePlain(String(id))).then((result) => {
        broadcast.itemsChanged();
        return result;
      });
    },
    // ★ 批量粘贴（P2-8）：多条按入参顺序拼成一段贴出去。图片行由 pasteMany 内部跳过
    //   —— 那是语义而不是失败，界面拿 ok:true 时仍应提示"已跳过 N 张图片"。
    [CH.items.pasteMany]: (_e, ids: string[]) => {
      const svc = pasteSvc;
      if (!svc) return { ok: false, reason: 'send-failed' };
      return Promise.resolve(svc.pasteMany(Array.isArray(ids) ? ids.map(String) : [])).then((result) => {
        broadcast.itemsChanged();
        return result;
      });
    },
    // ★ v0.3.0 起删除 = 进回收站（软删）：只盖 deleted_at、**不删盘**。
    //   所以这里没有任何"文件删不掉"的 toast —— 根本没删文件，留着那句提示只会误导用户。
    [CH.items.remove]: (_e, id: string) => {
      needDb().remove(String(id));
      broadcast.itemsChanged();
    },
    [CH.items.togglePin]: (_e, id: string) => {
      needDb().togglePin(String(id));
      broadcast.itemsChanged();
    },
    // ★ 批量删除（P2-8）：同样是软删（进回收站）。removeMany 返回的是被删的 ItemRow[]，
    //   界面契约要的是条数，所以这里取 length 而不是直接透传。
    [CH.items.removeMany]: (_e, ids: string[]) => {
      const list = Array.isArray(ids) ? ids.map(String) : [];
      if (list.length === 0) return 0;
      const n = needDb().removeMany(list).length;
      if (n > 0) broadcast.itemsChanged();
      return n;
    },
    // ★ 批量收藏/取消收藏：pinMany 返回改动的条数，但界面契约是 void，不往外透。
    [CH.items.pinMany]: (_e, ids: string[], pinned: boolean) => {
      const list = Array.isArray(ids) ? ids.map(String) : [];
      if (list.length === 0) return;
      needDb().pinMany(list, Boolean(pinned));
      broadcast.itemsChanged();
    },
    [CH.items.clearUnpinned]: () => {
      // ★ 软删：进回收站、文件留在盘上（用户还能撤销）。不删盘 → 没有"文件删不掉"这回事。
      const removed = needDb().clearUnpinned().length;
      broadcast.itemsChanged();
      return removed;
    },
    [CH.items.clearAll]: () => {
      // ★ 同上：软删全家桶，一个文件都不碰。真正的删盘只在 purge / 预算淘汰 / 回收站超限。
      const removed = needDb().clearAll();
      broadcast.itemsChanged();
      return removed;
    },
    // ★ 回收站五通道（T2）：trashList 必须过 mapThumbUrl —— 回收站里的图片也要显示缩略图，
    //   和 items:list 走同一条协议 URL 转换（库里存的是相对路径，渲染进程认不了）。
    [CH.items.trashList]: (_e, q) => needDb().listTrash(q ?? {}).map(mapThumbUrl),
    [CH.items.trashCount]: () => needDb().countTrash(),
    [CH.items.restore]: (_e, id: string) => {
      // ★ 语义在 ipc.ts 的 runRestore 里（可单测）：false 不抛异常，翻成
      //   {ok:false, reason:'duplicate'|'missing'}，界面据此提示而不是静默失败。
      const result = runRestore(needDb(), String(id));
      if (result.ok) {
        broadcast.itemsChanged();
      } else if (result.reason === 'duplicate') {
        broadcast.toast('同内容已在列表中，无需恢复', 'info');
      }
      return result;
    },
    [CH.items.purge]: (_e, ids: string[]) => {
      const list = Array.isArray(ids) ? ids.map((x) => String(x)) : [];
      if (list.length === 0) return { removed: 0 };
      // ★ 唯一删盘入口：purgeItemsWithFiles 先取相对路径 → 删行 → 删文件。
      const { removed, log } = purgeItemsWithFiles(needDb(), rt.dataDir, list, (m) =>
        logWarn('[images] ' + m)
      );
      // 这里是**真的删了盘**，文件删不掉值得如实告诉用户（残留会在下次启动被孤儿扫描清掉）。
      if (log.failures.length > 0) broadcast.toast('已永久删除，但有 ' + log.failures.length + ' 个图片文件未能删除', 'warn');
      broadcast.itemsChanged();
      return { removed };
    },
    [CH.items.emptyTrash]: () => {
      const db = needDb();
      // ★ 分页取全部回收站 id：listTrash 单次上限 500（db 的 MAX_LIMIT），
      //   一次取 500 条循环到取空为止，避免回收站里超过 500 条时只清掉一半。
      const ids: string[] = [];
      const PAGE = 500;
      for (;;) {
        const page = db.listTrash({ limit: PAGE, offset: ids.length });
        if (page.length === 0) break;
        for (const r of page) ids.push(r.id);
        if (page.length < PAGE) break;
      }
      if (ids.length === 0) return { removed: 0 };
      const { removed, log } = purgeItemsWithFiles(db, rt.dataDir, ids, (m) => logWarn('[images] ' + m));
      if (log.failures.length > 0) broadcast.toast('回收站已清空，但有 ' + log.failures.length + ' 个图片文件未能删除', 'warn');
      broadcast.itemsChanged();
      return { removed };
    },
    // ★ 原图给的是**协议 URL**，不是磁盘绝对路径：渲染层的 <img src> 认不了 file://，
    //   而且绝对路径一旦离开主进程就再也收不回来（spec §9.2 的边界）。
    [CH.items.getFullImage]: (_e, id: string) => {
      const row = needDb().getImageRow(String(id));
      if (!row || !row.image_path) return '';
      const abs = imageAbs(rt.dataDir, row.image_path);
      if (!fs.existsSync(abs)) return '';
      return imageUrlFor(row.image_path) ?? '';
    },
    [CH.items.count]: (_e, q: ListQuery) => needDb().count(q ?? {}),
    // ★ 导出（v0.3.0 起是 zip 备份包）：含原图，路径由用户在保存对话框里选。
    //   实现在 export-import.ts（不 import electron，可单测）；这里只负责把 dialog 注入进去。
    //   用户取消 → { ok:false, cancelled:true }，界面据此静默返回，不弹「导出失败」。
    [CH.items.exportAll]: () =>
      exportAllToZip({
        db: needDb(),
        dataDir: rt.dataDir,
        pickSave: async (defaultFileName) => {
          // 有窗口就挂在窗口上（模态，用户不会跑到后面去点别的），没有窗口就走无父窗口重载。
          const win = rt.win;
          const options = {
            title: '导出备份包',
            defaultPath: path.join(app.getPath('documents'), defaultFileName),
            filters: [{ name: 'Clipchan 备份包', extensions: ['zip'] }],
          };
          const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
          return { canceled: picked.canceled, filePath: picked.filePath };
        },
      }),
    // ★ 导入：选 zip → 逐条校验 → 单事务插入。绝不覆盖现有数据（重复 id/哈希一律跳过）。
    //   完成后必须广播 itemsChanged，否则列表还是旧的一屏（用户以为没导进来）。
    [CH.items.importAll]: async () => {
      const result = await importAllFromZip({
        db: needDb(),
        dataDir: rt.dataDir,
        pickOpen: async () => {
          const win = rt.win;
          const options = {
            title: '导入备份包',
            defaultPath: app.getPath('documents'),
            // 单选：一次导入一个包，多包合并留给以后（语义会更复杂）。
            properties: ['openFile'] as Array<'openFile'>,
            filters: [{ name: 'Clipchan 备份包', extensions: ['zip'] }],
          };
          const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
          return { canceled: picked.canceled, filePaths: picked.filePaths };
        },
      });
      if (result.ok) {
        broadcast.itemsChanged();
        broadcast.toast(importSummaryText(result), 'info');
      } else if (!result.cancelled) {
        // 取消是正常操作，静默；真失败要如实告诉用户原因（不是笼统的「导入失败」）。
        broadcast.toast('导入失败：' + (result.reason ?? '未知原因'), 'warn');
      }
      return result;
    },
    [CH.items.copy]: (_e, id: string) => {
      const svc = pasteSvc;
      if (!svc) return { ok: false, reason: 'send-failed' };
      return Promise.resolve(svc.copyItem(String(id)));
    },
    // ★ 正文全文（列表预览是截断的）：优化面板要原文，图片行/不存在一律空串。
    [CH.items.getText]: (_e, id: string) => needDb().getText(String(id)),
    // ★ v0.5.0：OCR 结果「存为一条新记录」。空串回 ok:false 而不是让 insertText 抛
    //   —— 面板已经按 canSaveAsItem 禁用了按钮，这里再抛只会把一句 SQLite 的报错摊给用户。
    [CH.items.saveText]: (_e, text: string) => {
      const body = typeof text === 'string' ? text : '';
      if (body.trim() === '') return { ok: false };
      const result = needDb().insertText(body);
      // 列表由事件刷新：不广播的话用户存完看不到新记录（以为没成功）。
      broadcast.itemsChanged();
      return { ok: true, id: result.id };
    },
    // ★ 拖出到外部应用（P1-5）：真正发起拖拽的只能是主进程（webContents.startDrag）。
    //   ★ startDrag 会阻塞到拖放结束（内部是 Windows 的 DoDragDrop 模态循环），所以这个
    //     handler 期间主进程是停住的：里面不要再 await 任何东西，也不要再广播别的消息。
    [CH.items.startDrag]: (e, id: string) => {
      const db = needDb();
      const row = db.getRow(String(id));
      const spec = dragPayloadFor(String(id), row, {
        dataDir: rt.dataDir,
        filePaths: row ? db.getFilePaths(String(id)) : [],
        imageAbs: (rel) => imageAbs(rt.dataDir, rel),
        // 原图被清理策略删掉、或文件记录指向的文件已不在：startDrag 拿到不存在的路径
        // 会抛在主进程里，异常既到不了界面也留不下提示，所以先在这里筛掉。
        exists: (p) => fs.existsSync(p),
      });
      if (!spec) {
        // ★ 不静默：用户拖了没反应只会以为程序卡了。文本/文件各有各的原因，分开说。
        const hint = (row ? dragHintFor(row.kind) : null) ?? DRAG_HINT_NO_FILE;
        broadcast.toast(hint, 'info');
        return;
      }
      // ★ startDrag 的 icon 必须是真实存在的文件，否则它直接抛（主进程弹错误框）。
      //   文件记录在 dragout 里回的是空串，这里用应用图标兜底。
      const icon = spec.icon.length > 0 ? spec.icon : assetPath('build', 'icon.ico');
      // ★ files 只在真有多个文件时才带上。Electron 的 gin 绑定用 item.Get("files", &files)
      //   先探这个键：键存在但值是 undefined 时转换失败，会连带把 file 分支一起跳过，
      //   表现就是"拖了没反应、也没提示"。少一个键比多一个 undefined 安全。
      const payload = spec.files && spec.files.length > 0
        ? { file: spec.file, files: spec.files, icon }
        : { file: spec.file, icon };
      e.sender.startDrag(payload);
    },
    // ★ v1.0.0 ⑥：标签 / 文件夹归类。两条都是"改了列表里某行的属性"，不是新增行，
    //   所以不返回数据 —— 广播 itemsChanged 让界面重拉即可（与 remove/togglePin 同一范式）。
    [CH.items.setTags]: (_e, id: string, tags: string[]) => {
      needDb().setTags(String(id), Array.isArray(tags) ? tags : []);
      broadcast.itemsChanged();
    },
    [CH.items.setFolder]: (_e, id: string, folderId: string | null) => {
      needDb().setFolder(String(id), folderId === undefined ? null : folderId);
      broadcast.itemsChanged();
    },
    // 只读统计：和上面两条写通道相反，回数据、不广播（否则界面拉完统计又触发一次重拉）。
    [CH.items.listTags]: () => needDb().listTags(),
    // ★ 片段库（v0.6.0）：四个通道都回整表，界面拿返回值直接 setSnippets，不用再查一次。
    //   广播用 broadcast.send(EV.snippetsChanged) —— Broadcaster 没有 snippetsChanged 方法
    //   （ipc.ts 不在本任务边界内），send 是它已有的通用出口。
    [CH.snippets.list]: () => needDb().listSnippets(),
    [CH.snippets.save]: (_e, input: SnippetInput) => {
      const next = needDb().saveSnippet(input ?? { title: '', content: '' });
      broadcast.send(EV.snippetsChanged);
      return next;
    },
    [CH.snippets.remove]: (_e, id: string) => {
      const next = needDb().removeSnippet(String(id));
      broadcast.send(EV.snippetsChanged);
      return next;
    },
    // ★ 「使用」= 复制并贴回目标窗口。界面层只做 `setSnippets(await snippets.use(id))`
    //   （packages/core/src/ui/App.tsx 的 useSnippet），自己不碰剪贴板也不模拟粘贴 ——
    //   所以这两步必须在这里做，否则按钮点下去毫无反应。
    //   pasteText 内部已先写剪贴板、再尝试贴回，且永不抛（失败回诚实的 PasteResult）。
    [CH.snippets.use]: (_e, id: string) => {
      const db = needDb();
      const snippet = db.getSnippet(String(id));
      const next = db.touchSnippet(String(id));
      broadcast.send(EV.snippetsChanged);
      const svc = pasteSvc;
      if (snippet && svc) {
        void svc.pasteText(snippet.content).then((result) => {
          // 区分两种失败：no-target 是"已复制、只是没处可贴"，其余是压根没写进剪贴板。
          if (result.ok) return;
          if (result.reason === 'no-target') broadcast.toast('片段已复制，但没有可粘贴的目标窗口', 'info');
          else broadcast.toast('片段复制失败', 'warn');
        });
      }
      return next;
    },
    // ★ v1.0.0 ⑥ 整理文件夹：五个通道与 snippets 同一范式 —— 写操作回**变更后的整表**，
    //   界面拿返回值直接重建树，不用再补一次 list。list 只读，不进广播。
    [CH.folders.list]: () => needDb().listFolders(),
    [CH.folders.create]: (_e, input: FolderInput) => needDb().createFolder(input ?? { name: '' }),
    [CH.folders.rename]: (_e, id: string, name: string) => needDb().renameFolder(String(id), String(name)),
    // parentId=null 是"提升为顶层"，不是省略 —— 必须原样透传，不能被 ?? 兜成别的值。
    [CH.folders.move]: (_e, id: string, parentId: string | null) => needDb().moveFolder(String(id), parentId),
    [CH.folders.remove]: (_e, id: string) => needDb().removeFolder(String(id)),
    // ★ 优化结果「复制并粘贴」：同一段文本可能贴多次，不走 items:paste（那是库里的记录，
    //   会刷新排序）。不查库、不 touch，编排与 pasteItem 一致。
    [CH.ai.copyAndPaste]: (_e, text: string) => {
      const svc = pasteSvc;
      if (!svc) return { ok: false, reason: 'send-failed' };
      return Promise.resolve(svc.pasteText(typeof text === 'string' ? text : ''));
    },
    // ★ 只写剪贴板：不查库、不 touch、不模拟粘贴（优化面板「复制」用；与 copyAndPaste 区分）。
    [CH.clipboard.writeText]: (_e, text: string) => {
      const s = typeof text === 'string' ? text : '';
      if (s === '') return;
      // 自我抑制：程序自己写的不该被自己的 watcher 当成新复制入库。
      watcher?.suppressNext();
      clipboard.writeText(s);
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
          logWarn('[images] ' + m)
        );
      }
      // ★ 回收站上限调小要立刻收敛。db 内部顺手触发的超限淘汰拿不到被删 id（也就删不了盘），
      //   所以这里走带删盘的版本：先按 id 记路径 → 让 db 删行 → 删文件。
      if (patch && typeof patch.trashLimit === 'number') {
        purgeTrashOverLimitWithFiles(needDb(), rt.dataDir, (m) => logWarn('[images] ' + m));
      }
      // ★ 三个热键都要重注册：漏掉 capture 会让用户改完「截图标注」后旧键仍然生效、新键毫无反应。
      if (
        patch &&
        (typeof patch.hotkeyActivate === 'string' ||
          typeof patch.hotkeyWidget === 'string' ||
          typeof patch.hotkeyCapture === 'string')
      ) {
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
    // ★ 自动更新（P0-3）：只做"设置页手动点检查"，不在启动时自动 check
    //   —— 现在每次启动打一次 GitHub API 没收益，等真实用户量起来再加。
    [CH.app.checkUpdate]: () => (updater ? updater.check() : { state: 'none', message: '更新器未就绪' }),
    [CH.app.applyUpdate]: () => (updater ? updater.apply() : Promise.resolve()),
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
    // ★ v0.5.0 历史与截图/OCR 面写在展开之后：对象字面量后写的键覆盖前面的，
    //   所以这三条能盖掉 ai.ts 里那份 ai.optimize（要包一层才写得了历史）。
    [CH.ai.optimize]: async (_e, req: OptimizeRequest) => {
      const res = await needAi().optimize(req);
      recordOptimizeHistory(req, res);
      return res;
    },
    [CH.ai.history]: (_e, limit?: number) =>
      needDb().listOptimizeHistory(typeof limit === 'number' ? limit : undefined),
    [CH.ai.historyRemove]: (_e, id: string) => {
      needDb().removeOptimizeHistory(String(id));
    },
    [CH.ai.historyClear]: () => {
      needDb().clearOptimizeHistory();
    },
    // 截图四条：begin 由热键触发，其余由 overlay 页面（capture.html）调用。
    [CH.capture.begin]: () => beginCapture(),
    [CH.capture.target]: (_e, displayId: number) =>
      captureTargets.find((t) => t.displayId === Number(displayId)) ?? null,
    [CH.capture.finish]: (_e, p: CaptureFinishPayload) => finishCapture(p),
    [CH.capture.cancel]: () => {
      cancelCapture();
    },
    // OCR 三条：全部懒创建（needOcr 内部才建桥），冷启动与 smoke 都不为它付代价。
    [CH.ocr.status]: () => needOcr().status(),
    [CH.ocr.download]: () => needOcr().download(),
    [CH.ocr.recognize]: (_e, id: string) => {
      const row = needDb().getImageRow(String(id));
      if (!row || !row.image_path) throw new Error('这条记录不是图片');
      return needOcr().recognize(imageAbs(rt.dataDir, row.image_path));
    },
    // 二维码一条：与 OCR 同款懒创建。recognize 自己保证永不抛异常（识别不出回空串），
    // 所以这里只有"这条记录不是图片"会真的抛给渲染层。
    [CH.qr.recognize]: (_e, id: string) => {
      const row = needDb().getImageRow(String(id));
      if (!row || !row.image_path) throw new Error('这条记录不是图片');
      return needQr().recognize(imageAbs(rt.dataDir, row.image_path));
    },
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

/** buildHandlers() 里那份 needDb 是闭包局部量，模块级的截图/历史逻辑用这个。 */
function requireDb(): Db {
  if (!rt.db) throw new Error('数据库尚未就绪');
  return rt.db;
}

// ---------------- 截图会话（v0.5.0 T6） ----------------

/**
 * 一次截图会话的收尾：关掉全部 overlay 并清空本次状态。
 * ★ 成功 / 用户取消 / 出错三条路径都要走到这里，否则会留下一层吃掉全部鼠标事件的全屏窗。
 */
function cancelCapture(): void {
  const wins = captureOverlays;
  captureOverlays = [];
  captureTargets = [];
  // ★ 不能在这里同步 destroy：cancel / finish 都是从 overlay 页面自己发起的 IPC，
  //   回复还没发出去就把发起调用的那个窗拆掉，主进程会踩到已释放的 WebContents
  //   （实测表现：在遮罩上按 Esc，整个应用直接退出，退出码 -1）。
  //   推迟到本轮 IPC 回复之后再收窗，屏幕上的效果没有区别。
  setImmediate(() => closeOverlays(wins));
}

/**
 * 抓全部屏幕 → 每屏建一个 overlay 窗。
 * @returns 本次的 targets；抓不到任何屏幕时返回 null（并 toast 中文原因）。
 */
async function beginCapture(): Promise<CaptureTarget[] | null> {
  const broadcast = makeBroadcaster(() => rt.win);
  // ★ 连按热键：抓屏期间直接忽略（captureStarting），抓完之后先收掉上一次的 overlay，
  //   否则屏幕上会叠两层全屏窗（上层关掉才露出下层）。
  if (captureStarting) return null;
  captureStarting = true;
  try {
    return await startCaptureSession(broadcast);
  } finally {
    captureStarting = false;
  }
}

/** beginCapture 的实际工作（拆出来只为让上面那段守卫用 try/finally 包住全部出口）。 */
async function startCaptureSession(
  broadcast: ReturnType<typeof makeBroadcaster>
): Promise<CaptureTarget[] | null> {
  if (captureOverlays.length > 0) cancelCapture();

  const displays = screen.getAllDisplays();
  // thumbnailSize 只能给一个尺寸，所以取各屏物理像素的最大值：小屏抓大图只是多几个像素，
  // 大屏抓小图会被放大成糊图 —— 宁可多花内存也不给用户一张糊的底图。
  const sizes = displays.map((d) => thumbnailSizeFor(d));
  let sources: Awaited<ReturnType<typeof desktopCapturer.getSources>>;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, ...sizes.map((s) => s.width)),
        height: Math.max(1, ...sizes.map((s) => s.height)),
      },
    });
  } catch (e) {
    broadcast.toast('没能抓取屏幕内容，请重试', 'error');
    logWarn('[capture] 抓屏失败：' + (e instanceof Error ? e.message : String(e)));
    return null;
  }

  const targets: CaptureTarget[] = [];
  for (const display of displays) {
    // ★ 配不上就跳过这块屏（matchSource 绝不猜）：把别人的屏幕画到这块屏上比抓不到更糟。
    const matched = matchSource(sources, display, displays.length);
    if (!matched) continue;
    // matchSource 只声明了 getSize（它测得了），底图要 toDataURL，所以按 id 取回完整 source。
    const source = sources.find((s) => s.id === matched.id);
    if (!source) continue;
    targets.push({
      displayId: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      dataUrl: source.thumbnail.toDataURL(),
    });
  }
  if (targets.length === 0) {
    broadcast.toast('没能抓取屏幕内容，请重试', 'error');
    return null;
  }

  captureTargets = targets;
  captureOverlays = createOverlayWindows({
    targets,
    preload: preloadFile(),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    // 与 rendererFile() 同一条规则（main.ts:200-202）：dist-electron 上跳一级就是包根下的 dist。
    file: path.join(__dirname, '..', 'dist', 'capture.html'),
  });
  return targets;
}

/**
 * 把临时 id 的图片文件改名到库行 id 并回填路径。
 *
 * ★ 这段是 recorder.adoptId（recorder.ts:228-237）的照抄：那里是 private、签名也要
 *   SavedImage，而 recorder.ts 本次不许改。顺序与它逐行一致，两处必须同改同测。
 */
function adoptCaptureImageId(fromId: string, toId: string, saved: SavedImage): void {
  const ext = path.extname(saved.image_path) || '.png';
  const absImage = path.join(imagesDir(rt.dataDir), toId + ext);
  const absThumb = path.join(thumbsDir(rt.dataDir), toId + '.png');
  fs.renameSync(imageAbs(rt.dataDir, saved.image_path), absImage);
  fs.renameSync(imageAbs(rt.dataDir, saved.thumb_path), absThumb);
  requireDb()
    .raw.prepare('UPDATE items SET image_path = ?, thumb_path = ? WHERE id = ?')
    .run(toRelativePath(rt.dataDir, absImage), toRelativePath(rt.dataDir, absThumb), toId);
}

/**
 * 截图落库，返回记录 id。
 *
 * ★ 顺序照抄 recorder.recordImage（recorder.ts:171-225），不发明第三种写法：
 *   临时 id 落盘 → 哈希**磁盘字节** → db.insertImage（它自己生成 id）→ id 不同则改名回填。
 *   理由见那段注释：insertImage 不接受外部 id，而文件名必须是 images/<id>.<ext>，
 *   先落盘再改名才能保证"行指向的文件一定存在"。
 */
function persistCaptureImage(img: NativeImageLike): string {
  const db = requireDb();
  const dataDir = rt.dataDir;
  const tmpId = randomUUID().replace(/-/g, '');
  const saved = saveImage(dataDir, tmpId, img);
  const tmpRels = [saved.image_path, saved.thumb_path];

  // 去重键取**磁盘上那份原图字节**的 sha256：与 recorder 完全一致，否则同一张图
  // 从剪贴板进来和从截图进来会算出两个哈希，去重直接失效。
  const hash = hashImageBuffer(fs.readFileSync(imageAbs(dataDir, saved.image_path)));
  // ★ 感知哈希必须和 recorder 用**同一个函数**（imagePhash）算：
  //   截图与剪贴板是同一张图的两条入口，算法/通道序/缩放只要差一点，
  //   两边的 phash 就不是同一把尺子，"库里已有相似图"的判定会整体失效。
  const phash = imagePhash(img);
  const result = db.insertImage(
    {
      hash,
      width: saved.width,
      height: saved.height,
      bytes: saved.bytes,
      imagePath: saved.image_path,
      thumbPath: saved.thumb_path,
      // 算不出来就不带这个键（ImageMeta.phash 可选），别写 undefined 制造第二种"没值"。
      ...(phash === undefined ? {} : { phash }),
    },
    { now: Date.now(), source: 'capture' },
  );

  if (result.touched) {
    // 库里已有同一张图：它的文件在它自己的 id 下，刚落的这份是多余的。
    deleteImageFiles(dataDir, tmpRels, (m) => logWarn('[images] ' + m));
    return result.id;
  }

  if (result.id !== tmpId) {
    try {
      adoptCaptureImageId(tmpId, result.id, saved);
    } catch (e) {
      // 改名失败不回滚数据库：行已经建好，最坏是路径与文件名对不上（日志里留证据）。
      logWarn('[capture] 图片文件改名失败（库行 ' + result.id + '）：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // 与 recorder.afterWrite 对齐：截图也是图片写入，不按预算淘汰就等于绕开用户设的磁盘上限。
  try {
    const mb = rt.settings?.imageBudgetMB ?? DEFAULT_SETTINGS.imageBudgetMB;
    enforceImageBudget(db, dataDir, mb * 1024 * 1024, (m) => logWarn('[images] ' + m));
  } catch (e) {
    logWarn('[capture] 图片预算淘汰失败（已忽略）：' + (e instanceof Error ? e.message : String(e)));
  }
  return result.id;
}

/**
 * 标注完成：落库 + 按 action 分发（复制 / 粘贴 / 存文件）。
 * ★ 无论哪条路径最后都 cancelCapture()，overlay 绝不留在屏幕上。
 */
async function finishCapture(payload: CaptureFinishPayload): Promise<CaptureResult> {
  const broadcast = makeBroadcaster(() => rt.win);
  try {
    const img = nativeImage.createFromDataURL(String(payload?.pngDataUrl ?? ''));
    if (img.isEmpty()) return { ok: false, reason: '截图内容为空' };

    // ★ 先落库再分发：用户点了「存文件」却取消，记录也不该丢（这是有意的，见计划 §3 T6）。
    const recordId = persistCaptureImage(img);
    const action = payload.action;

    if (action === 'copy') {
      // 自我抑制：这条图刚由我们自己落库，不抑制的话轮询器会把同一张图再记一遍
      // （去重会挡住重复行，但仍会白跑一次哈希并把这条顶到最前）。
      watcher?.suppressNext();
      clipboard.writeImage(img);
    } else if (action === 'paste') {
      const svc = pasteSvc;
      if (!svc) return { ok: false, reason: '粘贴服务尚未就绪' };
      // pasteItem 内部已写剪贴板 + 尝试贴回前台窗口，这里不重复写。
      const pasted = await svc.pasteItem(recordId);
      broadcast.itemsChanged();
      // ★ 不无条件说「已粘贴到目标窗口」：没有可粘贴的目标 / 助手不可用时它只做到了复制，
      //   照 describeFinish 报成功就是在骗用户（pasteHintOf 才是这一跳的真相）。
      if (pasted.ok) broadcast.toast(describeFinish('paste'), 'info');
      else broadcast.toast(pasteHintOf(pasted), 'warn');
      return { ok: true, id: recordId };
    } else if (action === 'save') {
      const win = rt.win;
      const options = {
        title: '保存截图',
        defaultPath: path.join(app.getPath('pictures'), 'clipchan-shot-' + Date.now() + '.png'),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      };
      // 与 exportAll 同一写法：有窗口就挂模态，窗口已销毁就走无父窗口对话框。
      const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) {
        // 记录已经在库里，只是没存成文件 —— 静默返回，不弹「已保存为文件」。
        broadcast.itemsChanged();
        return { ok: true, id: recordId, cancelled: true };
      }
      fs.writeFileSync(picked.filePath, img.toPNG());
    } else {
      // IPC 传进来的 action 不受类型约束：认不出来就说清楚，不假装处理成功。
      return { ok: false, reason: '不认识的截图动作' };
    }

    broadcast.itemsChanged();
    broadcast.toast(describeFinish(action), 'info');
    return { ok: true, id: recordId };
  } catch (e) {
    const reason = e instanceof Error && e.message !== '' ? e.message : String(e);
    logWarn('[capture] 处理截图失败：' + reason);
    return { ok: false, reason: '处理截图失败：' + reason };
  } finally {
    cancelCapture();
  }
}

// ---------------- OCR（v0.5.0 T6） ----------------

/**
 * tesseract.js-core 的目录。
 *
 * ★ 必须指向 asar **外**：wasm 不能从 asar 里读（electron-builder.yml 的 asarUnpack 已把
 *   整个 tesseract.js-core 解到 app.asar.unpacked）。打包后 require.resolve 给出的仍是
 *   asar 内路径，所以要把 'app.asar' 换成 'app.asar.unpacked'。
 * ★ 包名走变量而不是字面量：esbuild 见字面量会尝试在打包期解析，而它是 tesseract.js 的
 *   传递依赖（pnpm 不提升），解析不到会直接让主进程构建失败。
 */
function ocrCorePath(): string {
  const pkg = 'tesseract.js-core/package.json';
  try {
    const dir = path.dirname(require.resolve(pkg));
    return dir.replace('app.asar', 'app.asar.unpacked');
  } catch {
    // 解析不到（极端裁剪过的安装）就按 electron-builder 的固定布局兜底，绝不回 asar 内。
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'tesseract.js-core');
  }
}

/** OCR 桥：懒创建（首次用到才建），smoke 与冷启动都不该为 OCR 付代价。 */
let ocrApi: OcrApi | null = null;
function needOcr(): OcrApi {
  if (ocrApi) return ocrApi;
  ocrApi = createOcr({
    // 语言包与 worker 缓存都随数据目录走，卸载重装不丢。
    langDir: path.join(rt.dataDir, 'ocr'),
    corePath: ocrCorePath(),
    onProgress: (p) => makeBroadcaster(() => rt.win).send(EV.ocrProgress, p),
    // ★ 预处理（放大 4×）只能在主进程做：ocr.ts 顶层不许 import electron，
    //   所以 nativeImage 由这里递进去。实测同一张图 4× 放大后 CER 0.446 → 0.223。
    // ★ 返回 null 表示「这张图不预处理」，ocr.ts 会退回直传路径 —— 放大只是提质手段，
    //   不能因为放大失败就把识别变成一次报错。
    prepare: (imagePath) => {
      try {
        const img = nativeImage.createFromPath(imagePath);
        if (img.isEmpty()) return null;
        const size = img.getSize();
        const target = upscaleSize(size.width, size.height);
        if (target.width === 0) return null;
        const resized = img.resize({ width: target.width, height: target.height, quality: 'best' });
        return { data: new Uint8Array(resized.toPNG()) };
      } catch (e) {
        logWarn('[ocr] 预处理失败，退回原图：' + (e instanceof Error ? e.message : String(e)));
        return null;
      }
    },
  });
  return ocrApi;
}

/** 二维码识别：同样懒创建（首次识别才加载 jsQR 与位图）。 */
let qrApi: QrApi | null = null;
function needQr(): QrApi {
  if (qrApi) return qrApi;
  qrApi = createQr({
    // ★ 位图接口只能在主进程注入：qrcode.ts 顶层不许 import electron（与 ocr.ts 同一条铁律）。
    //   返回 null 表示"这张图读不出来"，recognize 会把它归一成空串而不是抛异常。
    loadImage: (imagePath) => {
      const img = nativeImage.createFromPath(imagePath);
      return img.isEmpty() ? null : img;
    },
  });
  return qrApi;
}

// ---------------- 链接预览（v1.1.0） ----------------

/**
 * 链接预览抓取器：懒创建。
 * ★ 沿用 ocr.ts 里的全局 fetch，而不是 electron 的 net 模块：
 *   net 只在 app ready 之后可用，且会走 Chromium 的会话/代理配置，
 *   把"抓个 title"和用户的浏览器代理绑在一起反而更难解释。全局 fetch 走 Node 的 undici，
 *   超时与 abort 语义也更直白（url-meta.ts 里就靠 AbortSignal 兜底）。
 */
let urlMeta: UrlMetaApi | null = null;
function needUrlMeta(): UrlMetaApi {
  if (urlMeta) return urlMeta;
  urlMeta = createUrlMeta({ fetchImpl: (u, init) => fetch(u, init) });
  return urlMeta;
}

/** 链接预览缓存有效期：7 天。过期就当没缓存，重新抓一次。 */
const URL_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 后台抓一次链接预览（不阻塞录制管线）。
 * ★ 整段是"发射后不管"：调用方**不 await**，任何失败只留日志。
 *   链接预览是锦上添花，绝不能让一次网络超时卡住用户刚复制的一段文字。
 * ★ 只对 !touched 的新行调用：去重命中的那条本来就有预览（或者已经有主），
 *   再抓一次纯属浪费一次对外请求。
 */
function prefetchUrlPreview(id: string): void {
  try {
    const db = requireDb();
    const url = normalizeUrl(db.getText(id));
    // 不是链接就到此为止：绝大多数记录都是纯文本，别让它进入任何网络分支。
    if (!url) return;

    // ★ 缓存表就是干这个的：同一个链接被反复复制时不该每次都打一次对方服务器。
    const cached = db.getUrlPreviews([url])[0];
    if (cached && Date.now() - cached.fetchedAt < URL_PREVIEW_TTL_MS) return;

    void (async () => {
      try {
        const preview = await needUrlMeta().fetchPreview(url);
        if (!preview) return;
        // 二次确认行还在：抓取期间用户可能已经把这条删了/清空回收站。
        if (!requireDb().getRow(id)) return;
        requireDb().upsertUrlPreview(preview);
        makeBroadcaster(() => rt.win).itemsChanged();
      } catch (e) {
        logWarn('[url-preview] 抓取失败：' + (e instanceof Error ? e.message : String(e)));
      }
    })();
  } catch (e) {
    logWarn('[url-preview] 入队失败：' + (e instanceof Error ? e.message : String(e)));
  }
}

/**
 * 优化成功后写一条历史。
 * ★ 整段 try/catch：写历史是**附加**动作，它失败绝不能把已经拿到的优化结果变成一次报错。
 */
function recordOptimizeHistory(req: OptimizeRequest, res: OptimizeResult): void {
  try {
    const db = requireDb();
    // 键名与 ai.ts:35 的 PROVIDERS_KEY 是同一个（从那里 import，不在这里再写一遍字面量）。
    const raw = db.getSettingValue<{ id?: unknown; name?: unknown }[]>(PROVIDERS_KEY);
    const list = Array.isArray(raw) ? raw : [];
    const found = list.find((p) => p && String(p.id) === req.providerId);
    const name = found && typeof found.name === 'string' && found.name.trim() !== '' ? found.name : req.providerId;
    db.addOptimizeHistory({
      source: req.text,
      output: res.optimized,
      sceneId: req.sceneId,
      mode: req.mode,
      providerId: req.providerId,
      // provider 名字存快照：provider 后来被删，历史条目仍能看懂是谁生成的。
      providerName: name,
      createdAt: Date.now(),
    });
  } catch (e) {
    logWarn('[ai] 写历史失败：' + (e instanceof Error ? e.message : String(e)));
  }
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
    //   兜底超时见 PANEL_TARGET_TIMEOUT_MS（300ms）：热态往返 9-18ms，正常路径不会触及；
    //   原来的 120ms 在冷态（spawn→READY 427ms）必超时，这才是"粘到 Chrome"的间歇性根因。
    //   超时只是这次没拿到目标，不动已有句柄。
    if (tracker) {
      const outcome = await withTimeout(tracker.captureTarget(self), PANEL_TARGET_TIMEOUT_MS);
      if (outcome === null) logWarn('[tracker] 捕获前台窗口超时，沿用上一次的目标');
    }
    applyMode(rt.win, mode, rt.settings?.widgetSize);
    rt.win.show();
    rt.win.focus();
    void applyFrosted(true);
  }
}

/**
 * 给 Promise 加一个兜底超时：超时返回 null，**不取消**原任务（它自己会跑完并写回状态）。
 *
 * ★ 用途是"助手彻底失联时别把热键唤起挂住"，所以只用于可以安全丢弃结果的查询。
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
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
    // 截图由 overlay 自己收尾（finish/cancel 都会 cancelCapture），这里不 await。
    onCapture: () => void beginCapture(),
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
    // ★ 日志尽早开：setupDataDir() 之前拿不到 dataDir（SMOKE 还要改写 userData），
    //   所以这是能落盘的第一个位置。之后所有 warn/error 才有人接住。
    logSink = createLogSink({ dir: logsDir(rt.dataDir) });
    installCrashHooks(logSink, process, app);
    logSink.write('[main] 启动 v' + app.getVersion() + ' dataDir=' + rt.dataDir);

    // ★ 协议处理器必须在 ready 之后注册（registerSchemesAsPrivileged 已在上面的模块作用域执行）。
    registerThumbProtocol(rt.dataDir);
    const { db, recoveredFrom, restoredFrom } = setupStorage(rt.dataDir);
    recoveredFromDb = recoveredFrom ?? null;
    restoredFromDb = restoredFrom ?? null;
    rt.db = db;
    rt.settings = db.getSettings();

    // ★ smoke 只验骨架，不碰真实剪贴板，也不启动助手（保持冒烟又快又干净）。
    if (!SMOKE) setupServices(rt.dataDir);

    // ★ 定期备份：**轮询 1 小时、真备份 24 小时一次**。
    //   为什么不是直接 setInterval(24h)：应用很少连续开满一天，24 小时的定时器
    //   几乎永远等不到触发；1 小时的轮询 + shouldBackup 按"备份文件名时间戳"判间隔，
    //   关机重启后也能立刻补上欠的那一份（内存计时归零不影响判定）。
    // ★ 整段 try/catch 只 logWarn：备份永远不该影响启动或使用。smoke 跳过。
    if (!SMOKE) {
      setInterval(() => {
        try {
          if (!rt.db) return;
          const db = rt.db;
          const res = maybeBackup({
            dataDir: rt.dataDir,
            dbPath: dbFile(rt.dataDir),
            checkpoint: () => db.raw.pragma('wal_checkpoint(TRUNCATE)'),
            intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
            keep: DEFAULT_BACKUP_KEEP,
          });
          if (res.ran && res.result?.ok && res.result.path) logLine('[db] 自动备份 ' + res.result.path);
          else if (res.ran) logWarn('[db] 自动备份失败（不阻断运行）：' + (res.result?.reason ?? '未知原因'));
        } catch (e) {
          logWarn('[db] 定期备份异常（不阻断运行）：' + String(e));
        }
      }, BACKUP_POLL_MS);
    }

    // ★ 自动更新（P0-3）：开发环境整体禁用（app.isPackaged === false），否则每次启动都会
    //   去 GitHub 打一次请求并在控制台刷错误。构造完不自动 check —— 见 CH.app.checkUpdate 的注释。
    updater = new Updater({
      currentVersion: app.getVersion(),
      enabled: app.isPackaged,
      onStatus: (s) => makeBroadcaster(() => rt.win).send(EV.updateStatus, s),
      onLog: (m) => logWarn('[updater] ' + m),
    });

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

    // ★ 库损坏这条必须等页面加载完再发：setupStorage 跑的时候窗口还不存在，
    //   直接 toast 会被 makeBroadcaster 的 isDestroyed 守卫静默丢掉，用户永远不知道历史去哪了。
    // ★ 三分支：恢复成功是好消息（'info'），只留了档才用 'warn'，都没发生就不发。
    if ((restoredFromDb || recoveredFromDb) && !SMOKE) {
      const restored = restoredFromDb;
      const quarantined = recoveredFromDb;
      rt.win.webContents.once('did-finish-load', () => {
        const broadcast = makeBroadcaster(() => rt.win);
        if (restored) broadcast.toast('历史库损坏，已从备份 ' + restored + ' 自动恢复', 'info');
        else if (quarantined) broadcast.toast('历史库损坏，已备份为 ' + quarantined + '，已新建空库', 'warn');
      });
    }

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
    logLine(
      '[main] 数据目录 ' + rt.dataDir +
      '，自启目标 ' + autoStartPath(process.env, process.execPath) +
      '，快捷键 activate=' + rt.hotkeyStatus.activate +
      ' widget=' + rt.hotkeyStatus.widget +
      ' capture=' + rt.hotkeyStatus.capture +
      ' updater=' + (app.isPackaged ? 'on' : 'off')
    );
  }).catch((e: unknown) => {
    /**
     * 启动期任何一步失败都在这里收口。
     * ★ 以前是裸 `void whenReady().then(...)`：库打不开 / 端口被占 / 渲染文件缺失时，
     *   用户只看到窗口一闪而过，进程静默死掉，没有任何可排查的线索。
     * ★ SMOKE 下不能弹模态框，否则冒烟脚本会一直挂着等一个没人点的确定按钮。
     */
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    logError('[main] 启动失败：' + detail);
    if (!SMOKE) {
      dialog.showErrorBox(
        '剪贴板酱启动失败',
        (e instanceof Error ? e.message : String(e)) +
          '\n\n数据目录：' + rt.dataDir +
          '\n日志在 data/logs（设置 → 打开数据目录 可直达）',
      );
    }
    logSink?.close();
    logSink = null;
    app.exit(1);
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
  // 摘掉 electron-updater 的事件监听：不留悬挂引用，也让下一次 quit 不重复处理。
  updater?.dispose();
  void helperClient?.dispose();
  // ★ 日志最后关：上面几行的 dispose 自己也可能写日志，先关就把退出期的线索丢了。
  logSink?.close();
  logSink = null;
});

main();
