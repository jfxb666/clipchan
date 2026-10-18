/**
 * 自动粘贴编排（spec §7.2「自动粘贴（助手常驻）」；计划 Task 6）。
 *
 * 职责边界：本文件只做**编排**，一切 Win32 判定（三层验证 / 提权 / 归位）都在 C# 助手
 * 进程内完成（`packages/desktop/helper/ClipchanHelper.cs`），主进程这边只发
 * `PASTE <hwnd>` 并把结果码翻译成 `PasteResult`（翻译在 core 的 `mapHelperCode`，
 * 且 `HelperClient.paste()` 已经映射过，这里**不再映射第二遍**）。
 *
 * 编排顺序（逐条对应计划 Task 6 Step 285，照抄旧版 `legacy/src/MainForm.cs:804-832` Commit()）：
 *   ① 从 db 取该项（图片读原图字节）
 *   ② **先**把内容写进剪贴板（写之前由 writer 内部调 `watcher.suppressNext()` 抑制自己的这一跳）
 *   ③ `db.touch(id)`：刷新 created_at 与 seq，让刚用过的记录稳定排在最前
 *   ④ `tracker.consume()` 取本次目标（一次性消费，取出即清空）
 *   ⑤ 目标为 null（或自动粘贴开关关闭）→ 返回 `{ok:false, reason:'no-target'}`，
 *      **不调助手**；内容已经在剪贴板里，界面提示「已复制，按 Ctrl+V 粘贴」
 *   ⑥ 调 `helper.paste(hwnd)`，把助手给的结果原样返回
 *
 * 诚实降级（Global Constraints「不假装」）：
 * - `helper.available === false` → **不调** `helper.paste`，直接 `send-failed`；
 * - 记录不存在 / 图片路径缺失 / 图片文件读不出来 → 都不假装「已复制」；
 * - 剪贴板被别的进程锁住（writer 抛异常）→ 中止，不 touch、不消耗目标。
 *
 * 本文件不 import electron：所有外部依赖（db / helper / tracker / writer / 读文件）
 * 都是窄接口，可在 vitest 里注入假对象。
 */
import { readFileSync } from 'node:fs';
import type { PasteResult } from '@clipchan/core';
import type { Db } from './db';
import { imageAbs } from './paths';
import type { TargetTracker } from './target-tracker';

/**
 * 剪贴板写入的窄接口（真正的实现在 main.ts，内部**必须先** `watcher.suppressNext()`）。
 *
 * - `writeText`：纯文本；图片行的 content 恒为 NULL，不会被当文本写出去；
 * - `writeImage`：原图**字节**（PNG/JPEG），调用方自己 `nativeImage.createFromBuffer(bytes)`
 *   再 `clipboard.writeImage`（这样本模块不依赖 electron）。
 */
export interface ClipboardWriter {
  writeText(text: string): void;
  writeImage(image: Buffer): void;
}

/**
 * 助手客户端的窄接口（`HelperClient` 结构上就满足）。
 *
 * ★ `paste()` 返回的已经是 `PasteResult`（`HelperClient` 内部走过 `mapHelperCode`），
 *   所以 PasteService **不做第二次映射**。
 */
export interface PasteHelper {
  readonly available: boolean;
  paste(hwnd: number): Promise<PasteResult>;
}

/** 本编排真正用到的设置项（core 的 Settings 结构上就满足）。 */
export interface PasteSettings {
  /** 「Enter 自动粘贴」开关；关闭时只复制不粘贴（旧版 PastePolicy.ShouldAttemptAutoPaste）。 */
  autoPaste: boolean;
}

export interface PasteServiceDeps {
  db: Db;
  helper: PasteHelper;
  tracker: TargetTracker;
  /**
   * ★ 取**当前**设置，不是构造时的快照：用户在设置页里开关「Enter 自动粘贴」后
   *   必须立刻生效（实测过快照版本：开关打开后仍要重启应用才粘贴，且 capabilities
   *   也跟着报错）。传函数而不是对象就是为了让读的一刻永远是最新值。
   */
  getSettings: () => PasteSettings;
  writer: ClipboardWriter;
  /**
   * 数据目录（%APPDATA%\Clipchan）。库里的 image_path 是相对路径，靠它解析成绝对路径。
   * ★ 不传时图片记录**诚实回退**为 `send-failed`（读不到原图就不假装贴成功）。
   */
  dataDir?: string;
  /** 读原图字节，默认 `node:fs` 的 `readFileSync`（测试注入用）。 */
  readImage?: (absPath: string) => Buffer;
}

/** 内容已进剪贴板、但这次不注入：界面提示「已复制，按 Ctrl+V 粘贴」（spec §7.2 码 1/3）。 */
const COPY_ONLY: PasteResult = { ok: false, reason: 'no-target' };
/** 助手不可用 / 编排失败：诚实回退为「已复制，但自动粘贴失败，请按 Ctrl+V」。 */
const SEND_FAILED: PasteResult = { ok: false, reason: 'send-failed' };

/**
 * 把一条历史记录写进剪贴板并（可能）粘回目标窗口。
 *
 * 唯一对外的入口就是 `pasteItem(id)`，ipc.ts 的 `items:paste` 直接调它即可。
 */
export class PasteService {
  private readonly db: Db;
  private readonly helper: PasteHelper;
  private readonly tracker: TargetTracker;
  private readonly getSettings: () => PasteSettings;
  private readonly writer: ClipboardWriter;
  private readonly dataDir: string;
  private readonly readImage: (absPath: string) => Buffer;

  constructor(deps: PasteServiceDeps) {
    this.db = deps.db;
    this.helper = deps.helper;
    this.tracker = deps.tracker;
    this.getSettings = deps.getSettings;
    this.writer = deps.writer;
    this.dataDir = deps.dataDir ?? '';
    this.readImage = deps.readImage ?? ((absPath) => readFileSync(absPath));
  }

  /**
   * 粘贴一条记录：复制进剪贴板 + 尝试自动贴回目标窗口。
   *
   * 永不抛异常 —— 任何一步失败都返回一个诚实的 `PasteResult`（上层据此提示用户）。
   */
  async pasteItem(id: string): Promise<PasteResult> {
    const itemId = typeof id === 'string' ? id : '';
    if (itemId.length === 0) return SEND_FAILED;

    // ① 取项（图片行 content 为 NULL、image_path 是相对路径）
    const row = this.db.getRow(itemId);
    if (!row) {
      // 记录已被删除（与界面的一次竞态）：没内容可复制，按「没有可粘贴的目标」回退。
      return COPY_ONLY;
    }

    // ② 先写剪贴板。writer 内部必须先 suppressNext()，否则自己这一跳会被轮询记成新记录。
    try {
      if (row.kind === 'image') {
        const rel = row.image_path;
        if (!rel || this.dataDir.length === 0) return SEND_FAILED;
        const bytes = this.readImage(imageAbs(this.dataDir, rel));
        if (!bytes || bytes.length === 0) return SEND_FAILED;
        this.writer.writeImage(bytes);
      } else {
        const text = row.content ?? '';
        if (text.length === 0) return SEND_FAILED;
        this.writer.writeText(text);
      }
    } catch {
      // 剪贴板被别的进程锁住（Electron 的 clipboard.* 会抛）：中止本跳，
      // 不 touch、不消耗目标（旧版 Commit() 的 try/catch 同样是"直接放弃"）。
      return SEND_FAILED;
    }

    // ③ 刷新时间与 seq —— 「刚复制过的」稳定排第一（旧版 Store.Touch）
    this.db.touch(itemId);

    // ④ 取目标：一次性消费，取出即清空（陈旧 HWND 绝不复用）
    const hwnd = this.tracker.consume();

    // ⑤ 不注入的两种情形：自动粘贴开关关闭 / 没有可粘贴的目标。
    //    内容已经在剪贴板里，界面提示「已复制，按 Ctrl+V 粘贴」，**不调助手**。
    if (!this.getSettings().autoPaste) return COPY_ONLY;
    if (hwnd === null) return COPY_ONLY;

    // ⑥ 助手不可用：不调用 paste()，直接诚实回退（exe 缺失/编译失败的降级路径）
    if (!this.helper.available) return SEND_FAILED;

    try {
      return await this.helper.paste(hwnd);
    } catch {
      // HelperClient 自身不会抛；这里只是把"意外"也压成诚实回退。
      return SEND_FAILED;
    }
  }

  /**
   * 只把一条记录复制进剪贴板：不注入、不消耗目标窗口、不刷新排序。
   *
   * 与 pasteItem 的差别只在第 ③④⑤⑥ 步全跳过 —— 用户明确要"复制"而不是"粘贴"，
   * 这时候去 touch（把它顶到最前）会打乱他自己排的顺序。
   */
  async copyItem(id: string): Promise<PasteResult> {
    const itemId = typeof id === 'string' ? id : '';
    if (itemId.length === 0) return SEND_FAILED;

    const row = this.db.getRow(itemId);
    if (!row) return COPY_ONLY;

    try {
      if (row.kind === 'image') {
        const rel = row.image_path;
        if (!rel || this.dataDir.length === 0) return SEND_FAILED;
        const bytes = this.readImage(imageAbs(this.dataDir, rel));
        if (!bytes || bytes.length === 0) return SEND_FAILED;
        this.writer.writeImage(bytes);
      } else {
        const text = row.content ?? '';
        if (text.length === 0) return SEND_FAILED;
        this.writer.writeText(text);
      }
    } catch {
      return SEND_FAILED;
    }
    // ★ 只复制成功回 ok:true。COPY_ONLY 是"粘贴时没有目标窗口"的语义，
    //   用它表示复制成功会让上层分不清「复制好了」和「复制没成」。
    return { ok: true };
  }

  /**
   * 把一段现成的文本复制进剪贴板并尝试自动贴回目标窗口（优化面板「复制并粘贴」）。
   *
   * 与 pasteItem 的第 ②③④⑤⑥ 步同构，唯一区别是内容来自入参：
   * **不查库、不 touch**（这段文本不是库里的一条记录，没有 created_at 要刷新）。
   * 永不抛异常 —— 失败一律返回诚实的 PasteResult。
   */
  async pasteText(text: string): Promise<PasteResult> {
    const body = typeof text === 'string' ? text : '';
    if (body.length === 0) return SEND_FAILED;

    // ② 先写剪贴板（writer 内部会先 suppressNext()，否则自己这一跳会被轮询记成新记录）
    try {
      this.writer.writeText(body);
    } catch {
      // 剪贴板被别的进程锁住：中止本跳，不消耗目标。
      return SEND_FAILED;
    }

    // ③ 跳过：这段文本不是库里的记录，没有 touched/seq 要刷新。

    // ④ 取目标：一次性消费，取出即清空（陈旧 HWND 绝不复用）
    const hwnd = this.tracker.consume();

    // ⑤ 不注入的两种情形：开关关闭 / 没有可粘贴的目标。内容已在剪贴板里。
    if (!this.getSettings().autoPaste) return COPY_ONLY;
    if (hwnd === null) return COPY_ONLY;

    // ⑥ 助手不可用：不调用 paste()，直接诚实回退。
    if (!this.helper.available) return SEND_FAILED;

    try {
      return await this.helper.paste(hwnd);
    } catch {
      return SEND_FAILED;
    }
  }
}
