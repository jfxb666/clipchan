/**
 * 图片文件的"策略"部分：磁盘预算淘汰 + 孤儿清理。
 *
 * ★ 本文件是**纯函数模块**，不 import electron、不碰 nativeImage —— 全部可在 Node 里单测。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMAGES_DIR_NAME, THUMBS_DIR_NAME } from './paths';

/** 默认图片磁盘预算 512MB（spec §7.3 / DEFAULT_SETTINGS.imageBudgetMB）。 */
export const DEFAULT_IMAGE_BUDGET_MB = 512;

/** 淘汰目标：删到预算的 80% 以下（spec §7.3）。 */
export const EVICTION_RATIO = 0.8;

/** 孤儿扫描需要的最小行信息。 */
export interface ImagePathRow {
  id: string;
  image_path: string | null;
  thumb_path: string | null;
}

/** 预算淘汰需要的行信息。 */
export interface BudgetRow {
  id: string;
  pinned: boolean;
  bytes: number;
  created_at: number;
  /** 回收站时间戳；活跃行为 null / undefined。回收站行在淘汰顺序里排最前。 */
  deletedAt?: number | null;
}

function toRelPosix(dir: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(dir, p) : p;
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}

/**
 * 列出一个目录里的普通文件。
 *
 * ★ T-B4：原来先 `readdirSync` 再对**每个条目** `statSync` —— 图片多的时候那是几万次
 *   syscall，而它整个跑在白屏路径上。改成 `withFileTypes`，类型直接来自 readdir 的返回。
 * ★ 一处有意的行为差异：符号链接不再算作文件（旧实现用 statSync 会跟随链接，
 *   于是 orphan 逻辑会把链接本身 unlink 掉）。images/ 与 thumbs/ 只由本应用写入，
 *   里面不该有链接；真出现链接时"跳过不删"也比"跟着链接去删"安全。
 */
function listFiles(absDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return []; // 目录还不存在（全新安装）
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    out.push(path.join(absDir, entry.name));
  }
  return out;
}

/**
 * 扫描 `images/` 与 `thumbs/` 里的孤儿文件：**磁盘上有文件、库里没有对应行**。
 *
 * 反向的情形（库里有行、磁盘上没文件）不在这里处理，也不会出现在返回值里——
 * 那属于"文件丢了"，界面上应显示缩略图缺失，而不是删库里的行。
 *
 * @returns 被删除（或 dryRun 下将被删除）的**绝对路径**列表。
 */
export function sweepOrphans(
  dir: string,
  rows: ImagePathRow[],
  opts: { dryRun?: boolean; onLog?: (message: string) => void } = {},
): string[] {
  const log = opts.onLog ?? ((m: string) => console.warn('[images] ' + m));
  const known = new Set<string>();
  for (const r of rows ?? []) {
    if (r?.image_path) known.add(toRelPosix(dir, r.image_path));
    if (r?.thumb_path) known.add(toRelPosix(dir, r.thumb_path));
  }

  const removed: string[] = [];
  for (const sub of [IMAGES_DIR_NAME, THUMBS_DIR_NAME]) {
    for (const full of listFiles(path.join(dir, sub))) {
      const rel = toRelPosix(dir, full);
      if (known.has(rel)) continue;
      removed.push(full);
      if (opts.dryRun) continue;
      try {
        fs.unlinkSync(full);
      } catch (e) {
        log('孤儿文件删除失败（已忽略）：' + full + ' —— ' + String(e));
      }
    }
  }
  return removed;
}

/** 回收站行的排序键：有 deleted_at 就是回收站行。 */
function isTrashed(row: BudgetRow): boolean {
  return typeof row.deletedAt === 'number';
}

/**
 * 预算淘汰计划：预算超了就按「回收站行优先，然后最旧的未收藏」的顺序删，
 * 直到总量降到预算的 80% 以下。
 *
 * ★ 为什么回收站行先删：它们已经在回收站里（用户点过删除），文件却还占着磁盘。
 *   先腾它们等于"回收站主动给预算让路"，能少删用户还想要的活跃记录。
 * ★ 回收站行仍然**计入总量**：文件确实还在盘上，不计数的话预算就是假的。
 * ★ 收藏图片（pinned）永远不出现在结果里——它占用的字节仍然计入总量（文件确实在磁盘上），
 *   但只能靠用户自己取消收藏或手动清理，界面上给警告即可（spec §7.3）。
 *
 * @returns 需要删除的记录 id（按删除顺序：回收站行在前，同类内最旧在前）。
 */
export function planBudgetEviction(rows: BudgetRow[], budgetBytes: number): string[] {
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : 0;
  if (budget === 0) return [];

  const all = (rows ?? []).filter((r) => r && typeof r.id === 'string');
  let total = all.reduce((sum, r) => sum + Math.max(0, r.bytes || 0), 0);
  const target = Math.floor(budget * EVICTION_RATIO);
  if (total <= target) return [];

  const byAge = (a: BudgetRow, b: BudgetRow): number =>
    a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const candidates = all.filter((r) => !r.pinned);
  const trashed = candidates.filter(isTrashed).sort(byAge);
  const active = candidates.filter((r) => !isTrashed(r)).sort(byAge);

  const out: string[] = [];
  for (const c of [...trashed, ...active]) {
    if (total <= target) break;
    total -= Math.max(0, c.bytes || 0);
    out.push(c.id);
  }
  return out;
}
