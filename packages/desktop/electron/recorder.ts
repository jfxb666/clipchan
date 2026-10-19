/**
 * 剪贴板内容的记录管线（spec §7.1 / §7.3；计划 Task 5）。
 *
 * 轮询器（watcher.ts）只负责"看见什么"，本文件负责"怎么落库"：
 * - `baseline()`：启动基线——开始轮询前静默读一次当前剪贴板，只更新"上次值"、**不写库**
 *   （否则启动前就躺在剪贴板里的东西会被记成一条历史，验收 27）；
 * - `recordText()`：classify 分类 + 10 万字符截断 + 交给 `db.insertText`（去重与双刷新在 db 层）；
 * - `recordImage()`：先落盘（`saveImage`）再落库（`db.insertImage`），并保证
 *   **文件名与库行 id 一致**、**淘汰时同步删文件**、**按预算删最旧未收藏**。
 *
 * ★ 本文件不 import electron：剪贴板走窄接口，图片走 `NativeImageLike`。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classify, type Settings } from '@clipchan/core';
import { TEXT_LIMIT, type Db, type InsertResult } from './db';
import {
  enforceImageBudget,
  deleteImageFiles,
  hashImageBuffer,
  saveImage,
  type NativeImageLike,
  type SavedImage,
} from './images';
import { DEFAULT_IMAGE_BUDGET_MB } from './images-policy';
import { imageAbs, imagesDir, thumbsDir, toRelativePath } from './paths';
import {
  LastSeen,
  hasImageFormat,
  hasTextFormat,
  probeImage,
  shouldSkipFormats,
  type ClipboardLike,
} from './watcher';

export interface RecorderDeps {
  db: Db;
  /** 剪贴板窄接口（与轮询器共用同一个实例）。 */
  clip: ClipboardLike;
  /** 数据目录 %APPDATA%\Clipchan。 */
  dataDir: string;
  /** 每次都重新取设置：用户在设置页改了 historyLimit / imageBudgetMB 立刻生效。 */
  settings: () => Settings;
  now?: () => number;
  onLog?: (message: string) => void;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 来源应用名归一化：空白/空串一律当"未知"（undefined），绝不写空串或占位串。
 *
 * 数据库里"未知"只有一个表示法——NULL。写 "" 会让"按来源分组"多出一个空分组。
 */
export function normalizeSourceApp(sourceApp: string | null | undefined): string | undefined {
  if (typeof sourceApp !== 'string') return undefined;
  const trimmed = sourceApp.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 记录器。
 *
 * `lastSeen` 与轮询器**共享同一份**（轮询器从 `recorder.lastSeen` 读），
 * 这样"启动基线 / 幽灵恢复重置"只需要动这一个地方。
 */
export class Recorder {
  readonly lastSeen = new LastSeen();

  private readonly db: Db;
  private readonly clip: ClipboardLike;
  private readonly dataDir: string;
  private readonly getSettings: () => Settings;
  private readonly nowFn: () => number;
  private readonly onLog: (message: string) => void;

  constructor(deps: RecorderDeps) {
    this.db = deps.db;
    this.clip = deps.clip;
    this.dataDir = deps.dataDir;
    this.getSettings = deps.settings;
    this.nowFn = deps.now ?? (() => Date.now());
    this.onLog = deps.onLog ?? ((m: string) => console.warn('[recorder] ' + m));
  }

  /**
   * 启动基线（验收 27）。
   *
   * 开始轮询**之前**静默读一次剪贴板：把当前内容记进 `lastSeen`，**不入库**。
   * 读不到（剪贴板被占用等）就清空"上次值"——宁可多记一条，也不要因为读失败而
   * 假装"已经知道"从而漏掉用户真正的复制。
   *
   * 幽灵模式结束时也调它（幽灵期间剪贴板可能被换过，恢复后第一跳不补录）。
   */
  baseline(): void {
    try {
      const fmts = this.clip.availableFormats();
      if (shouldSkipFormats(fmts) !== 'none') {
        this.lastSeen.reset();
        return;
      }
      if (hasImageFormat(fmts)) {
        const probe = probeImage(this.clip, fmts);
        this.lastSeen.text = null;
        this.lastSeen.imageSig = probe.sig;
        return;
      }
      if (hasTextFormat(fmts)) {
        const text = this.clip.readText() ?? '';
        this.lastSeen.text = text.length > 0 ? text : null;
        this.lastSeen.imageSig = null;
        return;
      }
      this.lastSeen.reset();
    } catch (e) {
      this.lastSeen.reset();
      this.log('建立启动基线失败（按"未知"处理）：' + describeError(e));
    }
  }

  /**
   * 记录一条文本。
   *
   * 截断与去重 db 层也会做一遍（两层结果一致），这里显式做是为了把
   * "10 万字符上限 + truncated 标记"这条规格钉在记录管线里，而不是散落在存储层。
   */
  recordText(text: string, sourceApp?: string): InsertResult | null {
    if (typeof text !== 'string') return null;
    const cleaned = text.replace(/\0/g, '');
    if (cleaned.length === 0) return null;

    let content = cleaned;
    let truncated = false;
    if (content.length > TEXT_LIMIT) {
      content = content.slice(0, TEXT_LIMIT);
      truncated = true;
    }

    try {
      const result = this.withEvictionWatch(() =>
        this.db.insertText(content, {
          kind: classify(content),
          truncated,
          now: this.nowFn(),
          // 去重命中时 db 不刷新来源：已有行记的是"最初那条"的真实来源，
          // 拿后来的来源覆盖它才是错的。
          sourceApp: normalizeSourceApp(sourceApp),
        }),
      );
      this.afterWrite();
      return result;
    } catch (e) {
      this.log('文本记录失败（已忽略）：' + describeError(e));
      return null;
    }
  }

  /**
   * 记录一张图片。
   *
   * ★ 顺序上的一个硬约束：`db.insertImage` **自己生成 id**、不接受外部 id，而文件名必须是
   *   `images/<id>.<ext>`。所以这里先用一个临时 id 落盘、拿到库行 id 后把文件改名并回填路径
   *   （`adoptId`）。这样 INSERT 时路径就是可用的，进程中途崩溃也不会出现"行指向不存在的文件"
   *   —— 最坏只留下一个临时文件，由启动时的孤儿扫描兜底（spec §7.3）。
   *
   * 去重命中（同一张图已在库里）时：丢弃刚落盘的临时文件，库行保持原样并刷新排序（db 层做）。
   */
  recordImage(img: NativeImageLike, sig?: string | null, sourceApp?: string): InsertResult | null {
    if (!img || typeof img.isEmpty !== 'function' || img.isEmpty()) return null;

    const tmpId = randomUUID().replace(/-/g, '');
    let saved: SavedImage;
    try {
      saved = saveImage(this.dataDir, tmpId, img);
    } catch (e) {
      this.log('图片落盘失败（已忽略）：' + describeError(e));
      return null;
    }

    const tmpRels = [saved.image_path, saved.thumb_path];

    let result: InsertResult;
    try {
      // 去重键 = 磁盘上那份原图字节的 sha256（与"库里存的到底是什么"完全一致）
      const hash = hashImageBuffer(fs.readFileSync(imageAbs(this.dataDir, saved.image_path)));
      result = this.withEvictionWatch(() =>
        this.db.insertImage(
          {
            hash,
            width: saved.width,
            height: saved.height,
            bytes: saved.bytes,
            imagePath: saved.image_path,
            thumbPath: saved.thumb_path,
          },
          { now: this.nowFn(), sourceApp: normalizeSourceApp(sourceApp) },
        ),
      );
    } catch (e) {
      this.log('图片记录失败（已忽略）：' + describeError(e));
      deleteImageFiles(this.dataDir, tmpRels, this.onLog);
      return null;
    }

    if (result.touched) {
      // 库里已有同一张图：它的文件在它自己的 id 下，刚落的这份是多余的
      deleteImageFiles(this.dataDir, tmpRels, this.onLog);
      return result;
    }

    if (result.id !== tmpId) {
      try {
        this.adoptId(tmpId, result.id, saved);
      } catch (e) {
        // 改名失败不回滚数据库：行已经建好，最坏是路径与文件名对不上（日志里留证据）
        this.log('图片文件改名失败（库行 ' + result.id + '）：' + describeError(e));
      }
    }

    this.afterWrite();
    return result;
  }

  /** 把临时 id 的文件改名到库行 id，并回填库里的路径。 */
  private adoptId(fromId: string, toId: string, saved: SavedImage): void {
    const ext = path.extname(saved.image_path) || '.png';
    const absImage = path.join(imagesDir(this.dataDir), toId + ext);
    const absThumb = path.join(thumbsDir(this.dataDir), toId + '.png');
    fs.renameSync(imageAbs(this.dataDir, saved.image_path), absImage);
    fs.renameSync(imageAbs(this.dataDir, saved.thumb_path), absThumb);
    this.db.raw
      .prepare('UPDATE items SET image_path = ?, thumb_path = ? WHERE id = ?')
      .run(toRelativePath(this.dataDir, absImage), toRelativePath(this.dataDir, absThumb), toId);
  }

  /**
   * 包住一次写入，捕捉 `db.evictOverLimit()` 顺手淘汰掉的图片行，并**同步删掉它们的图片文件**。
   *
   * ★ v0.3.0 起 `evictOverLimit` 是**软删**（只盖 `deleted_at`），所以"前后差集"恒为空 ——
   *   按 id 差集判断会一个文件都删不到，被淘汰的图片永远留在盘上。
   *   这里改成看 `deleted_at` 的**翻转**：写入前活跃、写入后进回收站的行才是本次淘汰的目标。
   * ★ 只认"活跃 → 回收站"这一个方向：回收站 → 活跃（恢复）不该删文件；
   *   回收站里本来就有的行也不该被这次写入顺手删盘。
   * ★ 已经在回收站里的行**不重复删文件**：它们的文件按 §1.1 必须留着等用户恢复或 purge。
   *   所以这里刻意**不删盘**——上限淘汰进回收站，文件留在原处（这正是回收站的意义）。
   */
  private withEvictionWatch<T>(fn: () => T): T {
    const before = new Map(this.db.allImageRows().map((r) => [r.id, r.deleted_at] as const));
    const result = fn();
    // 仅用于诊断：把"本次写入把哪些活跃图片行送进了回收站"记一笔，
    // 便于真机上核对上限淘汰确实发生了（文件按设计不删）。
    const moved: string[] = [];
    for (const row of this.db.allImageRows()) {
      if (row.deleted_at === null) continue;
      const was = before.get(row.id);
      if (was === null) moved.push(row.id);
    }
    if (moved.length > 0) this.log('上限淘汰把 ' + moved.length + ' 条图片记录送进回收站（文件保留）');
    return result;
  }

  /** 每次写入后按图片预算淘汰（spec §7.3：删到预算的 80% 以下，收藏不动）。 */
  private afterWrite(): void {
    const mb = this.getSettings().imageBudgetMB;
    const budget = (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_IMAGE_BUDGET_MB) * 1024 * 1024;
    try {
      enforceImageBudget(this.db, this.dataDir, budget, this.onLog);
    } catch (e) {
      this.log('图片预算淘汰失败（已忽略）：' + describeError(e));
    }
  }

  private log(message: string): void {
    try {
      this.onLog(message);
    } catch {
      // 日志失败绝不影响主流程
    }
  }
}
