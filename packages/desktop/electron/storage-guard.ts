/**
 * 启动自检：坏库恢复 + 自动备份的**决策层**。
 *
 * ★ 为什么要有这一层：这两段逻辑原本长在 main.ts 里，而 main.ts import electron，
 *   vitest 的 node 环境根本 import 不进来 —— 于是"损坏了到底会不会用备份恢复"
 *   这种最该测的判断只能靠人肉点。把决策抽成纯函数后，main.ts 只剩装配。
 * ★ 本文件是**纯模块**：不 import electron，只 import node:fs / node:path 与
 *   ./backup ./paths，因此能在 vitest 里直接跑真 SQLite 文件。
 * ★ 两侧都**绝不抛**：启动路径上一次异常冒泡就是白屏，宁可诚实降级成"新建空库"。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createBackup,
  DEFAULT_BACKUP_INTERVAL_MS,
  DEFAULT_BACKUP_KEEP,
  findLatestHealthyBackup,
  latestBackupTime,
  restoreBackup,
  shouldBackup,
} from './backup';
import type { BackupResult, RestoreBackupResult } from './backup';
import { backupsDir } from './paths';

/**
 * 坏库恢复依赖。
 *
 * ★ looksCorrupt / quarantine 由主进程注入而不是在本模块重写：它们和 openDb 的
 *   判定口径必须一致，且 quarantine 要负责把 -wal/-shm 一起挪走（只挪主库会让
 *   新库回放旧 WAL 再坏一次），这套细节已经在 main.ts 里调好，不该有第二份实现。
 */
export interface RecoverDeps {
  dataDir: string;
  dbPath: string;
  /** 主进程注入：现有的 dbLooksCorrupt 口径。 */
  looksCorrupt: (file: string) => boolean;
  /** 主进程注入：现有的 backupCorruptDb（改名留档，返回文件名）。 */
  quarantine: (dbPath: string, dataDir: string) => string;
  /** 注入便于单测。 */
  findBackup?: (dir: string) => string | undefined;
  /** 注入便于单测。 */
  restore?: (dbPath: string, backupPath: string) => RestoreBackupResult;
}

export interface RecoverResult {
  /** 从备份恢复成功时的备份文件名（不含目录）；否则 undefined。 */
  restoredFrom?: string;
  /** 走到「挪开坏库新建空库」兜底时，留档文件名。 */
  quarantinedFrom?: string;
  /** 恢复失败的原因（用于日志），没失败就是 undefined。 */
  restoreFailure?: string;
}

/**
 * 库坏了怎么办：优先从健康备份恢复，恢复不了才挪开新建空库。
 *
 * ★ 顺序不可换。备份是**用户数据还在**的唯一机会，而"挪开坏库新建空库"是
 *   数据确定丢了的兜底；先挪后恢复等于把仅有的现库也搭进去（现库虽然坏了，
 *   但损坏常常只是部分页，仍有被人工捞回的价值）。
 * ★ 恢复成功后**不再 quarantine**：库里有用户数据了，此时把 dbPath 挪走
 *   等于恢复完立刻又清空。调用方随后用 existsSync 判 isFresh，也依赖这一点。
 * ★ 走到兜底时 dbPath 可能已经不存在（restoreBackup 成功了一半、或用户手删了），
 *   所以改名之前必须判存在 —— rename 一个不存在的文件会抛 ENOENT 炸掉启动。
 */
export function recoverCorruptDb(deps: RecoverDeps): RecoverResult {
  const { dataDir, dbPath } = deps;
  // ★ 健康库一律不碰：这条短路必须最靠前，恢复/改名都有副作用。
  if (!deps.looksCorrupt(dbPath)) return {};

  const findBackup = deps.findBackup ?? findLatestHealthyBackup;
  const restore = deps.restore ?? restoreBackup;
  const dir = backupsDir(dataDir);

  let backupPath: string | undefined;
  try {
    backupPath = findBackup(dir);
  } catch (e) {
    // 找备份本身失败（目录权限等）不阻断启动，按"没有备份"走兜底。
    return quarantineOnly(deps, 'find-failed: ' + msgOf(e));
  }

  if (backupPath === undefined) {
    // ★ 无备份时也写 restoreFailure='no-backup'：日志里"没备份"和"备份恢复失败"
    //   是两种完全不同的现场（前者该劝用户开备份，后者该查备份文件），不能混。
    return quarantineOnly(deps, 'no-backup');
  }

  let restored: RestoreBackupResult;
  try {
    restored = restore(dbPath, backupPath);
  } catch (e) {
    // ★ restoreBackup 自己是不抛的（失败走 reason），但注入体/底层 IO 可能抛；
    //   启动路径上任何异常都不许冒泡。
    restored = { ok: false, reason: 'threw: ' + msgOf(e) };
  }

  if (restored.ok) {
    // ★ 此处绝不 quarantine：用户数据已经回来了。
    return { restoredFrom: path.basename(backupPath) };
  }

  return quarantineOnly(deps, restored.reason ?? 'restore-failed');
}

/** 兜底：能挪就挪开坏库，挪不了也不能炸启动。 */
function quarantineOnly(deps: RecoverDeps, reason: string): RecoverResult {
  // ★ 主库可能已被 restore 覆盖/删除，判存在再改名（见 recoverCorruptDb 头注释）。
  if (!fs.existsSync(deps.dbPath)) return { restoreFailure: reason };
  try {
    return { quarantinedFrom: deps.quarantine(deps.dbPath, deps.dataDir), restoreFailure: reason };
  } catch (e) {
    // 改名失败（EBUSY 等）仍要往下走：openDb 会对这个坏库给出明确错误。
    return { restoreFailure: reason + '; quarantine-failed: ' + msgOf(e) };
  }
}

/** 自动备份依赖。 */
export interface MaybeBackupDeps {
  dataDir: string;
  dbPath: string;
  /** 调用方注入：对**持有写句柄的那条连接**刷 WAL（见 backup.ts 文件头 ★）。 */
  checkpoint: () => void;
  /** 时间源（单测可注入固定时间）。 */
  now?: () => number;
  /** 备份间隔，默认 24 小时。 */
  intervalMs?: number;
  /** 保留份数，默认 7。 */
  keep?: number;
}

export interface MaybeBackupResult {
  /** 是否真的尝试了备份（未到间隔 → false）。 */
  ran: boolean;
  result?: BackupResult;
}

/**
 * 到点就备份一次。
 *
 * ★ 用**备份文件名里的时间戳**判断该不该备份（latestBackupTime），不是内存里的
 *   "上次备份时间"：关机重启后内存归零，用内存计数会让每次启动都白备份一份。
 * ★ 备份失败绝不影响启动：createBackup 自己不抛（失败走 reason），这里再兜一层
 *   异常，把"抛了"也翻译成 ok:false —— 备份是增值功能，不能拿它换启动。
 */
export function maybeBackup(deps: MaybeBackupDeps): MaybeBackupResult {
  // ★ 整个函数包在 try 里：createBackup 自己不抛，但它的注入依赖（now / checkpoint）
  //   以及底层 IO 仍可能抛。备份是增值功能，一次异常都不该冒到启动路径上。
  try {
    const now = deps.now ? deps.now() : Date.now();
    const intervalMs = deps.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
    const keep = deps.keep ?? DEFAULT_BACKUP_KEEP;

    let lastAt: number | undefined;
    try {
      lastAt = latestBackupTime(backupsDir(deps.dataDir));
    } catch {
      // 读不出来就当从没备份过：多备份一份无害，少备份一份可能致命。
      lastAt = undefined;
    }
    if (!shouldBackup(lastAt, now, intervalMs)) return { ran: false };

    return {
      ran: true,
      // ★ createBackup 的 now 是**时间源函数**（它内部还要再取一次），不是毫秒数。
      result: createBackup({ dataDir: deps.dataDir, dbPath: deps.dbPath, checkpoint: deps.checkpoint, now: () => now, keep }),
    };
  } catch (e) {
    return { ran: true, result: { ok: false, reason: 'threw: ' + msgOf(e) } };
  }
}

/** 异常 → 一行人话（日志里要能读，不能是 [object Object]）。 */
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
