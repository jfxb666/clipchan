/**
 * 自动粘贴编排（spec §7.2「自动粘贴（助手常驻）」；计划 Task 6）。
 *
 * 职责边界：本文件只做**编排**，一切 Win32 判定（三层验证 / 提权 / 归位）都在 C# 助手
 * 进程内完成（`packages/desktop/helper/ClipchanHelper.cs`），主进程这边只发
 * `PASTE <hwnd>` 并把结果码翻译成 `PasteResult`（翻译在 core 的 `mapHelperCode`，
 * 且 `HelperClient.paste()` 已经映射过，这里**不再映射第二遍**）。
 *
 * 编排顺序（逐条对应计划 Task 6 Step 285，照抄旧版 `legacy/src/MainForm.cs:804-832` Commit()）：
 *   ① 从 db 取该项（图片读原图字节 / 文件记录取路径列表）
 *   ② **先**把内容写进剪贴板（写之前由 writer 内部调 `watcher.suppressNext()` 抑制自己的这一跳）
 *   ③ `db.touch(id)`：刷新 created_at 与 seq，让刚用过的记录稳定排在最前
 *   ④ `tracker.consume()` 取本次目标（一次性消费，取出即清空）
 *   ⑤ 目标为 null（或自动粘贴开关关闭）→ 返回 `{ok:false, reason:'no-target'}`，
 *      **不调助手**；内容已经在剪贴板里，界面提示「已复制，按 Ctrl+V 粘贴」
 *   ⑥ 调 `helper.paste(hwnd)`，把助手给的结果原样返回
 *
 * 出方向的四个入口：
 * - `pasteItem`：复制 + 尝试贴回（Ctrl+V 那一跳）；
 * - `copyItem`：只复制，不 touch、不消耗目标；
 * - `pastePlain`：一键粘贴为纯文本（丢掉 text/html，只写纯文本）；
 * - `pasteMany`：多条记录按列表顺序用换行拼成一段再贴出去。
 *
 * 诚实降级（Global Constraints「不假装」）：
 * - 可用性判断**只在 helper 层做**：编排层不预判 `helper.available`，一律交给
 *   `helper.paste()`（它内部会按需重启助手），失败就如实返回 `send-failed`；
 * - 记录不存在 / 图片路径缺失 / 图片文件读不出来 → 都不假装「已复制」；
 * - 文件记录的路径列表空了（记录还在、文件信息丢了）→ `missing`，不当成功；
 * - 剪贴板被别的进程锁住（writer 抛异常）→ 中止，不 touch、不消耗目标。
 *
 * 本文件不 import electron：所有外部依赖（db / helper / tracker / writer / 读文件）
 * 都是窄接口，可在 vitest 里注入假对象。
 */
import { readFileSync } from 'node:fs';
import type { PasteResult } from '@clipchan/core';
import { TEXT_LIMIT, type Db, type ItemRow } from './db';
import { imageAbs } from './paths';
import type { TargetTracker } from './target-tracker';

/**
 * 剪贴板写入的窄接口（真正的实现在 main.ts，内部**必须先** `watcher.suppressNext()`）。
 *
 * - `writeText`：纯文本；图片行的 content 恒为 NULL，不会被当文本写出去；
 * - `writeImage`：原图**字节**（PNG/JPEG），调用方自己 `nativeImage.createFromBuffer(bytes)`
 *   再 `clipboard.writeImage`（这样本模块不依赖 electron）；
 * - `writeFiles`：文件记录，写**标准 CF_HDROP**（走原生助手，见 helper.ts 的 writeFiles）。
 *   ★ 可选：手机端 / 老平台没有这个能力，此时编排层诚实回 `no-target`，不假装复制成功；
 *   ★ 返回 false / reject = 真的没写成功（助手不可用、剪贴板被占用），编排层回 `send-failed`。
 *     之所以允许 Promise，是因为真正的写入要过一次助手进程的行协议往返；
 * - `writeRich`：同时写 text/html 与 text/plain。★ 可选，没有就退回 `writeText`。
 */
export interface ClipboardWriter {
  writeText(text: string): void;
  writeImage(image: Buffer): void;
  writeFiles?(paths: string[]): boolean | Promise<boolean> | void;
  writeRich?(html: string, text: string): void;
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
/** 助手注入失败（不可用 / 重启后仍失败 / 编排意外）：诚实回退为「已复制，但自动粘贴失败，请按 Ctrl+V」。 */
const SEND_FAILED: PasteResult = { ok: false, reason: 'send-failed' };
/** 记录还在，但内容 / 文件路径已经丢了：不能报成「已复制」（那不是复制成功，是数据缺失）。 */
const MISSING: PasteResult = { ok: false, reason: 'missing' };

/**
 * 把一条历史记录写进剪贴板并（可能）粘回目标窗口。
 *
 * 对外的四个入口见文件头注释；ipc.ts 的 `items:paste` / `items:copy` /
 * `items:pastePlain` / `items:pasteMany` 分别调它们。
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

    // ① 取项（图片行 content 为 NULL、image_path 是相对路径；文件行路径在另一张表）
    const row = this.db.getRow(itemId);
    if (!row) {
      // 记录已被删除（与界面的一次竞态）：没内容可复制，按「没有可粘贴的目标」回退。
      return COPY_ONLY;
    }

    // ② 先写剪贴板。writer 内部必须先 suppressNext()，否则自己这一跳会被轮询记成新记录。
    let wrote: PasteResult;
    try {
      wrote = await this.writeRowToClipboard(row);
    } catch {
      // 剪贴板被别的进程锁住（Electron 的 clipboard.* 会抛）：中止本跳，
      // 不 touch、不消耗目标（旧版 Commit() 的 try/catch 同样是"直接放弃"）。
      return SEND_FAILED;
    }
    // 没写成功（图片读不出来 / 文件路径丢了 / 平台不支持写文件）就别往下走：
    // touch 会把它顶到最前、consume 会把目标窗口用掉，两者都不该在失败时发生。
    if (!wrote.ok) return wrote;

    // ③ 刷新时间与 seq —— 「刚复制过的」稳定排第一（旧版 Store.Touch）
    // ④⑤⑥ 取目标 / 判定 / 注入
    return this.pasteInto([itemId]);
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

    let wrote: PasteResult;
    try {
      wrote = await this.writeRowToClipboard(row);
    } catch {
      return SEND_FAILED;
    }
    if (!wrote.ok) return wrote;

    // ★ 只复制成功回 ok:true。COPY_ONLY 是"粘贴时没有目标窗口"的语义，
    //   用它表示复制成功会让上层分不清「复制好了」和「复制没成」。
    return { ok: true };
  }

  /**
   * 一键粘贴为纯文本（Ctrl+Shift+V）：丢掉 text/html，只写纯文本。
   *
   * 从网页复制的内容贴到记事本里会带上格式，这个入口给「我只要字」的场景。
   * 与 pasteItem 的差别只在第 ② 步：正文取 `db.getText()`（列表预览是截断的，
   * 这里要全文），且**不查 getRichHtml**。
   *
   * 图片行例外：对图片谈"纯文本"没有意义，仍按 pasteItem 的方式写原图。
   */
  async pastePlain(id: string): Promise<PasteResult> {
    const itemId = typeof id === 'string' ? id : '';
    if (itemId.length === 0) return SEND_FAILED;

    const row = this.db.getRow(itemId);
    if (!row) return COPY_ONLY;

    try {
      if (row.kind === 'image') {
        const wrote = await this.writeRowToClipboard(row);
        if (!wrote.ok) return wrote;
      } else {
        const text = this.db.getText(itemId);
        // 空文本 / 文件行（没有可当文本的内容）→ 明确报缺失，不把空串塞进剪贴板。
        if (text.length === 0) return MISSING;
        this.writer.writeText(text);
      }
    } catch {
      return SEND_FAILED;
    }

    return this.pasteInto([itemId]);
  }

  /**
   * 批量粘贴：把多条记录按**入参顺序**用换行拼成一段再贴出去。
   *
   * ★ 图片行被**故意跳过**：图片字节没法拼进一段文本，跳过是语义而不是 bug
   *   （界面应据此提示「已跳过 N 张图片」，不要当成失败）。
   * ★ 拼接结果按 `TEXT_LIMIT` 截断并保留头部：超长文本写进剪贴板会让接收方卡死。
   */
  async pasteMany(ids: string[]): Promise<PasteResult> {
    const list = Array.isArray(ids) ? ids : [];
    if (list.length === 0) return MISSING;

    const parts: string[] = [];
    const touched: string[] = [];
    for (const raw of list) {
      const id = typeof raw === 'string' ? raw : '';
      if (id.length === 0) continue;
      const row = this.db.getRow(id);
      if (!row) continue;
      // 图片没法拼进文本：跳过（见方法头注释）。
      if (row.kind === 'image') continue;
      const text = this.db.getText(id);
      if (text.length === 0) continue;
      parts.push(text);
      touched.push(id);
    }
    if (parts.length === 0) return MISSING;

    const merged = parts.join('\n');
    const body = merged.length > TEXT_LIMIT ? merged.slice(0, TEXT_LIMIT) : merged;

    try {
      this.writer.writeText(body);
    } catch {
      return SEND_FAILED;
    }

    // 参与拼接的行才 touch：被跳过 / 拼完为空的那些不该被顶到最前。
    return this.pasteInto(touched);
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
    return this.pasteInto([]);
  }

  /**
   * 按 kind 把一行的内容写进剪贴板（pasteItem / copyItem / pastePlain 共用）。
   *
   * 抽出来的理由：三个入口 + 三种 kind 一共九种组合，散在调用点会立刻出现
   * "文件分支只改了一处、另一处还在写文本"的漏改（旧代码里图片分支就是复制两份的）。
   *
   * 返回值语义：`{ok:true}` 表示内容已经进了剪贴板；否则就是这次写失败的诚实原因。
   * ★ 本方法会抛 —— 调用方负责把 writer 的异常压成 `send-failed`。
   */
  private async writeRowToClipboard(row: ItemRow): Promise<PasteResult> {
    if (row.kind === 'image') {
      const rel = row.image_path;
      if (!rel || this.dataDir.length === 0) return SEND_FAILED;
      const bytes = this.readImage(imageAbs(this.dataDir, rel));
      if (!bytes || bytes.length === 0) return SEND_FAILED;
      this.writer.writeImage(bytes);
      return { ok: true };
    }

    if (row.kind === 'files') {
      const paths = this.db.getFilePaths(row.id);
      // 记录还在但路径丢了：这是数据缺失，不能当"复制成功"。
      if (paths.length === 0) return MISSING;
      // 平台没有写 CF_HDROP 的能力（手机端 / 老平台）：诚实说没有可粘贴的目标。
      // ★ 写完再 writeText 会把文件格式清掉，所以这里绝不补文本。
      if (!this.writer.writeFiles) return COPY_ONLY;
      const wrote = await this.writer.writeFiles(paths);
      // 明确回 false 才算失败；老 writer 返回 void（undefined）按"尽力写了"处理。
      if (wrote === false) return SEND_FAILED;
      return { ok: true };
    }

    const text = row.content ?? '';
    if (text.length === 0) return SEND_FAILED;
    // 富文本：库里存了 html 且 writer 支持才走 writeRich（它同时写 text/plain，
    // 所以贴到记事本里也不会变成一坨 HTML 源码）。
    const html = this.db.getRichHtml(row.id);
    if (html !== null && html.length > 0 && this.writer.writeRich) {
      this.writer.writeRich(html, text);
    } else {
      this.writer.writeText(text);
    }
    return { ok: true };
  }

  /**
   * 复制成功之后的公共尾巴：③ touch → ④ consume → ⑤ 判定 → ⑥ 注入。
   *
   * `touchedIds` 为空表示这次没有库里的记录要刷新（pasteText 用它）。
   */
  private async pasteInto(touchedIds: string[]): Promise<PasteResult> {
    // ③ 刷新时间与 seq —— 「刚复制过的」稳定排第一（旧版 Store.Touch）
    for (const id of touchedIds) this.db.touch(id);

    // ④ 取目标：一次性消费，取出即清空（陈旧 HWND 绝不复用）
    const hwnd = this.tracker.consume();

    // ⑤ 不注入的两种情形：自动粘贴开关关闭 / 没有可粘贴的目标。
    //    内容已经在剪贴板里，界面提示「已复制，按 Ctrl+V 粘贴」，**不调助手**。
    if (!this.getSettings().autoPaste) return COPY_ONLY;
    if (hwnd === null) return COPY_ONLY;

    // ⑥ 注入：可用性判断交给 helper 层（它自己会 ensureChild 重启；exe 缺失时
    //    直接返回 send-failed）。编排层再拦一道会挡住「助手已死但可自愈」的情形。
    try {
      return await this.helper.paste(hwnd);
    } catch {
      // HelperClient 自身不会抛；这里只是把"意外"也压成诚实回退。
      return SEND_FAILED;
    }
  }
}
