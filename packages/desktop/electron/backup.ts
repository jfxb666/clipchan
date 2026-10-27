/**
 * 数据库自动备份 + 损坏自动恢复。
 *
 * ★ 本文件是**纯模块**，不 import electron —— 同 paths.ts，能在 Node / vitest 里直接单测。
 *
 * ★ 为什么不在这里自己 new Database 打开"正在用的库"：
 *   主库的句柄由调用方（main.ts 的 setupStorage）独占持有，多开一个连接去做
 *   wal_checkpoint 会撞上 "database is locked"，而且 checkpoint 必须跑在**持有写句柄的
 *   那条连接**上才有意义。所以备份前刷 WAL 这一步由调用方以 checkpoint 回调注入。
 *
 * ★ 为什么必须先 checkpoint 再复制：库是 WAL 模式，已提交但还没落盘的事务只存在于
 *   -wal 里。直接 copyFile 主库会得到一个"看起来完整、实际丢最近若干条"的备份 ——
 *   这种备份最坏，因为它能通过 quick_check，恢复时才发现记录少了。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { backupsDir } from './paths';

/** 备份文件名前缀。 */
export const BACKUP_PREFIX = 'clipchan-';
/** 备份文件名后缀。 */
export const BACKUP_SUFFIX = '.db';
/** 保留份数：只留最近 7 份（一天一份 ≈ 一周）。 */
export const DEFAULT_BACKUP_KEEP = 7;
/** 备份间隔：距上次备份超过 24 小时才做一次。 */
export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 合法备份文件名。★ 用白名单正则而不是 endsWith('.db')：
 * 复制中途的 .tmp、用户自己丢进来的 clipchan.corrupt-*.db 都不该进备份列表，
 * 更不该参与"保留 7 份"的裁剪（否则可能把真备份裁掉、留下垃圾）。
 */
const BACKUP_NAME_RE = /^clipchan-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

/** 备份依赖。checkpoint 由调用方注入，见文件头 ★。 */
export interface BackupDeps {
  dataDir: string;
  dbPath: string;
  /** 调用方注入：对当前打开的库执行 wal_checkpoint(TRUNCATE)。 */
  checkpoint: () => void;
  /** 时间源（单测可注入固定时间）。 */
  now?: () => number;
  /** 保留份数，默认 7。 */
  keep?: number;
  /**
   * ★ 仅为单测注入失败点：默认用 fs.copyFileSync。
   *   用它验证"复制中途失败时不留下 .tmp 残骸"这条路径。
   */
  copyFile?: (src: string, dest: string) => void;
}

/** 备份结果。失败用 reason 说明，不抛。 */
export interface BackupResult {
  ok: boolean;
  /** 成功时：新备份的绝对路径。 */
  path?: string;
  /** 失败原因（机器可读前缀 + 人话）。 */
  reason?: string;
  /** 本次裁剪掉的份数。 */
  pruned?: number;
}

/** 恢复结果。失败用 reason 说明，不抛。 */
export interface RestoreBackupResult {
  ok: boolean;
  /** 失败原因（机器可读前缀 + 人话）。 */
  reason?: string;
  /** 成功时：被恢复的备份文件绝对路径。 */
  path?: string;
}

/** 两位补零。 */
function pad2(n: number): string {
  return n < 10 ? '0' + String(n) : String(n);
}

/**
 * 把时间戳格式化成备份文件名里的 \`YYYYMMDD-HHmmss\`。
 *
 * ★ 刻意用**本地时间**而不是 toISOString() 的 UTC 时分秒：
 *   备份文件名是给用户看的（设置页 / 资源管理器），UTC 会让东八区用户看到
 *   "比实际早 8 小时"的时间，误以为备份没生效。
 */
export function formatBackupStamp(at: number): string {
  const d = new Date(at);
  return (
    String(d.getFullYear()) +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

/** 备份文件名（不含目录）。 */
export function backupFileName(at: number): string {
  return BACKUP_PREFIX + formatBackupStamp(at) + BACKUP_SUFFIX;
}

/** 从备份文件名反解时间戳；不是合法备份名则返回 undefined。 */
export function parseBackupStamp(name: string): number | undefined {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  // 本地时间构造，与 formatBackupStamp 对称。
  const ms = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 列出备份目录里的合法备份，**按时间从新到旧**。
 * 目录不存在时返回空数组（首次启动的正常状态，不是错误）。
 */
export function listBackups(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const valid: { file: string; at: number }[] = [];
  for (const name of names) {
    const at = parseBackupStamp(name);
    if (at === undefined) continue;
    valid.push({ file: path.join(dir, name), at });
  }
  // 时间戳相同则按文件名兜底，保证排序稳定（单测里会造同秒文件）。
  valid.sort((a, b) => (b.at - a.at) || b.file.localeCompare(a.file));
  return valid.map((v) => v.file);
}

/**
 * 最近一次备份的时间（毫秒）；从未备份过返回 undefined。
 *
 * ★ 以**文件名里的时间戳**为准，而不是 mtime：用户复制数据目录、网盘同步都会
 *   改写 mtime，而文件名不会。备份名自带秒级时间戳，是最可靠的来源。
 */
export function latestBackupTime(dir: string): number | undefined {
  const newest = listBackups(dir)[0];
  if (newest === undefined) return undefined;
  return parseBackupStamp(path.basename(newest));
}

/**
 * 是否该做备份了。
 *
 * ★ 纯函数，便于单测；调用方传入"上次备份时间"（可由 latestBackupTime 推出）。
 *   从未备份 → true；距上次不足间隔 → false；超过间隔 → true。
 */
export function shouldBackup(
  lastAt: number | undefined,
  now: number,
  intervalMs: number = DEFAULT_BACKUP_INTERVAL_MS,
): boolean {
  if (lastAt === undefined || !Number.isFinite(lastAt)) return true;
  if (!Number.isFinite(now)) return false;
  return now - lastAt >= intervalMs;
}

/**
 * 只读验活：能不能打开 + quick_check 第一条是否为 'ok'。
 *
 * ★ 和 main.ts 的 dbLooksCorrupt 同口径（只跑 quick_check，不跑 integrity_check：
 *   几十万条的库上 integrity_check 要几秒，恢复路径也在启动关键路径上）。
 * ★ 必须 readonly + fileMustExist：默认 open 会把"不存在的文件"顺手建成空库，
 *   一个空库能通过 quick_check，于是坏备份被当成健康备份恢复 —— 灾难。
 */
export function isHealthyDb(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  let probe: Database.Database | null = null;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    const rows: unknown = probe.pragma('quick_check');
    const first = Array.isArray(rows) && rows.length > 0 ? Object.values(rows[0] as object)[0] : null;
    // 健康库返回 [{quick_check:'ok'}]；损坏时返回第一条具体错误文本。
    return typeof first === 'string' && first.toLowerCase() === 'ok';
  } catch {
    // 连打开都失败（无 SQLite 魔数 / 页头损坏）也是坏库。
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
      /* 关不掉不影响判定 */
    }
  }
}

/** 删掉指定文件的 -wal / -shm sidecar；不存在就跳过。 */
function removeSidecars(dbPath: string): void {
  for (const ext of ['-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + ext, { force: true });
    } catch {
      /* 删不掉也继续：后续 openDb 会给出明确错误 */
    }
  }
}

/** 裁剪到最近 keep 份，返回裁掉的份数。 */
function pruneBackups(dir: string, keep: number): number {
  const all = listBackups(dir);
  let pruned = 0;
  for (let i = keep; i < all.length; i += 1) {
    const victim = all[i];
    if (victim === undefined) continue;
    try {
      fs.rmSync(victim, { force: true });
      pruned += 1;
    } catch {
      /* 单份删不掉不影响其余（可能是用户手动打开着） */
    }
  }
  return pruned;
}

/**
 * 做一次备份：先 checkpoint 刷 WAL，再 .tmp → rename 复制，最后裁剪到 keep 份。
 *
 * ★ .tmp → rename：复制过程中断电/被杀会留下半截文件。直接写最终名的半截文件
 *   在恢复路径上会被当作"最新备份"打开，quick_check 可能仍通过（SQLite 对
 *   截断的库有容错），于是恢复出一个残缺库。用临时名 + rename 保证最终名要么
 *   不存在、要么完整。
 */
export function createBackup(deps: BackupDeps): BackupResult {
  const now = deps.now ? deps.now() : Date.now();
  const keep = deps.keep ?? DEFAULT_BACKUP_KEEP;
  const dir = backupsDir(deps.dataDir);
  const copy = deps.copyFile ?? fs.copyFileSync;

  if (!fs.existsSync(deps.dbPath)) {
    return { ok: false, reason: 'no-db: 主库文件不存在，无需备份' };
  }

  // ★ 顺序不可换：checkpoint 必须在复制之前。
  try {
    deps.checkpoint();
  } catch (e) {
    // 刷不进 WAL 说明现在复制出来的库可能缺最近的事务，宁可不备份也不产出假备份。
    return { ok: false, reason: 'checkpoint-failed: ' + (e instanceof Error ? e.message : String(e)) };
  }

  const target = path.join(dir, backupFileName(now));
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    copy(deps.dbPath, tmp);
    fs.renameSync(tmp, target);
  } catch (e) {
    // 失败时清掉 .tmp：留着会被下次启动当成垃圾，也会让"备份目录很干净"的预期失效。
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清不掉也没别的办法 */
    }
    return { ok: false, reason: 'copy-failed: ' + (e instanceof Error ? e.message : String(e)) };
  }

  const pruned = pruneBackups(dir, keep);
  return { ok: true, path: target, pruned };
}

/**
 * 从新到旧找第一个健康备份；没有备份或全都坏了返回 undefined。
 *
 * ★ 返回 undefined 而不是抛：调用方据此走"新建空库"的兜底路径，
 *   "没有可用备份"是可解释状态，不是异常。
 */
export function findLatestHealthyBackup(dir: string): string | undefined {
  for (const file of listBackups(dir)) {
    if (isHealthyDb(file)) return file;
  }
  return undefined;
}

/**
 * 把备份复制回 dbPath，并清掉 dbPath 的 -wal / -shm。
 *
 * ★ 必须清 sidecar：旧 WAL 里是**旧库**的页，新文件回放它会立刻把库写坏 ——
 *   这正是 main.ts 的 backupCorruptDb 要把 sidecar 一起挪走的原因，恢复方向反过来同理。
 * ★ 顺序：先复制到 .tmp（此时不动现库），再删 sidecar，最后 rename。
 *   这样"备份本身坏了/读不出来"时现库毫发无损，只是恢复失败。
 * ★ 恢复前再验一次活：备份可能在这期间被用户/网盘改坏。
 */
export function restoreBackup(dbPath: string, backupPath: string): RestoreBackupResult {
  if (!fs.existsSync(backupPath)) {
    return { ok: false, reason: 'missing-backup: 备份文件不存在' };
  }
  if (!isHealthyDb(backupPath)) {
    return { ok: false, reason: 'unhealthy-backup: 备份未通过 quick_check' };
  }

  const tmp = dbPath + '.restore.tmp';
  try {
    fs.copyFileSync(backupPath, tmp);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'copy-failed: ' + (e instanceof Error ? e.message : String(e)) };
  }

  try {
    removeSidecars(dbPath);
    fs.renameSync(tmp, dbPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'replace-failed: ' + (e instanceof Error ? e.message : String(e)) };
  }

  return { ok: true, path: backupPath };
}
