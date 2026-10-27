import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_INTERVAL_MS,
  DEFAULT_BACKUP_KEEP,
  backupFileName,
  createBackup,
  findLatestHealthyBackup,
  isHealthyDb,
  latestBackupTime,
  listBackups,
  parseBackupStamp,
  restoreBackup,
  shouldBackup,
} from './backup';
import { backupsDir } from './paths';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-backup-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个真库（能过 quick_check），内容可由 tag 区分。 */
function makeDb(file: string, tag = 'seed'): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, content TEXT)');
    db.prepare('INSERT INTO items (id, content) VALUES (?, ?)').run('a'.repeat(32), tag);
  } finally {
    db.close();
  }
}

/** 固定时刻（本地时间），避免测试跑在不同时区/时刻上抖动。 */
function at(day: number, hour: number, minute: number, second: number): number {
  return new Date(2024, 0, day, hour, minute, second).getTime();
}

const NAME_RE = /^clipchan-\d{8}-\d{6}\.db$/;

describe('shouldBackup：距上次超过 24 小时才备份', () => {
  const now = at(10, 12, 0, 0);

  it('从未备份 → true', () => {
    expect(shouldBackup(undefined, now)).toBe(true);
  });

  it('距上次 1 小时 → false', () => {
    expect(shouldBackup(now - 60 * 60 * 1000, now)).toBe(false);
  });

  it('距上次 25 小时 → true', () => {
    expect(shouldBackup(now - 25 * 60 * 60 * 1000, now)).toBe(true);
  });

  it('正好等于间隔 → true（边界取 >=）', () => {
    expect(shouldBackup(now - DEFAULT_BACKUP_INTERVAL_MS, now)).toBe(true);
  });
});

describe('备份文件名：本地时间 YYYYMMDD-HHmmss', () => {
  it('格式符合 clipchan-YYYYMMDD-HHmmss.db，且用的是本地时分秒', () => {
    const ms = at(5, 7, 8, 9);
    const name = backupFileName(ms);
    expect(name).toMatch(NAME_RE);
    // ★ 必须是本地时间：用 getHours 反算，而不是 toISOString 的 UTC 时分秒。
    const d = new Date(ms);
    expect(name).toBe(
      'clipchan-20240105-' +
        String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') +
        String(d.getSeconds()).padStart(2, '0') +
        '.db',
    );
  });

  it('parseBackupStamp 与 backupFileName 对称；非法名返回 undefined', () => {
    const ms = at(5, 7, 8, 9);
    expect(parseBackupStamp(backupFileName(ms))).toBe(ms);
    expect(parseBackupStamp('clipchan.db')).toBeUndefined();
    expect(parseBackupStamp('clipchan.corrupt-2024-01-05-07-08-09.db')).toBeUndefined();
    expect(parseBackupStamp('clipchan-20240105-070809.db.tmp')).toBeUndefined();
  });
});

describe('createBackup', () => {
  it('产出可打开且通过 quick_check 的库，文件名符合规范', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');
    makeDb(dbPath);

    const res = createBackup({ dataDir: dir, dbPath, checkpoint: () => {}, now: () => at(1, 2, 3, 4) });

    expect(res.ok).toBe(true);
    const file = res.path as string;
    expect(existsSync(file)).toBe(true);
    // 固定时刻 2024-01-01 02:03:04（本地时间）
    expect(file).toBe(join(backupsDir(dir), 'clipchan-20240101-020304.db'));
    expect(isHealthyDb(file)).toBe(true);

    // 备份里的数据真的在（不是空库）。
    const probe = new Database(file, { readonly: true });
    try {
      expect((probe.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check).toBe('ok');
      const row = probe.prepare('SELECT content FROM items WHERE id = ?').get('a'.repeat(32));
      expect(row).toEqual({ content: 'seed' });
    } finally {
      probe.close();
    }
  });

  it('先 checkpoint 再复制（顺序断言）', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');
    makeDb(dbPath);
    const order: string[] = [];

    const res = createBackup({
      dataDir: dir,
      dbPath,
      checkpoint: () => order.push('checkpoint'),
      now: () => at(1, 2, 3, 4),
      copyFile: (src, dest) => {
        order.push('copy');
        // 用真复制，保证后续断言文件有效
        writeFileSync(dest, readFileSync(src));
      },
    });

    expect(res.ok).toBe(true);
    expect(order).toEqual(['checkpoint', 'copy']);
  });

  it('WAL 里未落盘的数据必须被 checkpoint 刷进去（真库端到端）', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');

    // 真·WAL 库：连接保持打开，新行只落在 -wal 里。
    const live = new Database(dbPath);
    try {
      live.pragma('journal_mode = WAL');
      live.exec('CREATE TABLE items (id TEXT PRIMARY KEY, content TEXT)');
      // 先把建表刷进主库，让"未落盘"的只有下面这一行 —— 这才是真实场景。
      live.pragma('wal_checkpoint(TRUNCATE)');
      live.prepare('INSERT INTO items (id, content) VALUES (?, ?)').run('b'.repeat(32), 'in-wal');

      // ★ 不 checkpoint 直接复制：主库文件里没有这条（这正是必须在复制前刷 WAL 的原因）。
      const naive = join(dir, 'naive.db');
      writeFileSync(naive, readFileSync(dbPath));
      const naiveDb = new Database(naive, { readonly: true });
      try {
        expect(naiveDb.prepare('SELECT content FROM items WHERE id = ?').get('b'.repeat(32))).toBeUndefined();
      } finally {
        naiveDb.close();
      }

      const res = createBackup({
        dataDir: dir,
        dbPath,
        checkpoint: () => {
          live.pragma('wal_checkpoint(TRUNCATE)');
        },
        now: () => at(6, 0, 0, 0),
      });

      expect(res.ok).toBe(true);
      const file = res.path as string;
      expect(isHealthyDb(file)).toBe(true);
      const probe = new Database(file, { readonly: true });
      try {
        expect(probe.prepare('SELECT content FROM items WHERE id = ?').get('b'.repeat(32))).toEqual({
          content: 'in-wal',
        });
      } finally {
        probe.close();
      }
    } finally {
      live.close();
    }
  });

  it('checkpoint 抛错 → ok:false 且不复制、不留文件', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');
    makeDb(dbPath);
    let copied = false;

    const res = createBackup({
      dataDir: dir,
      dbPath,
      checkpoint: () => {
        throw new Error('database is locked');
      },
      now: () => at(1, 2, 3, 4),
      copyFile: () => {
        copied = true;
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('checkpoint-failed');
    expect(copied).toBe(false);
    expect(listBackups(backupsDir(dir))).toEqual([]);
  });

  it('复制中途失败 → ok:false，不留 .tmp 残骸、不产出备份', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');
    makeDb(dbPath);

    const res = createBackup({
      dataDir: dir,
      dbPath,
      checkpoint: () => {},
      now: () => at(1, 2, 3, 4),
      copyFile: (_src, dest) => {
        // 模拟写到一半磁盘满
        writeFileSync(dest, 'half-written');
        throw new Error('ENOSPC: no space left on device');
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('copy-failed');
    const left = readdirSync(backupsDir(dir));
    expect(left.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(left).toEqual([]);
  });

  it('主库不存在 → ok:false（no-db），不抛', () => {
    const dir = tmpDir();
    const res = createBackup({ dataDir: dir, dbPath: join(dir, 'clipchan.db'), checkpoint: () => {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('no-db');
  });
});

describe('保留策略：只留最近 7 份', () => {
  it('预置 9 个备份 → 再备份一次后只剩最新 7 个', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');
    makeDb(dbPath);
    const bdir = backupsDir(dir);

    // 预置 9 份（时间各不相同），再各写入合法内容。
    for (let i = 0; i < 9; i += 1) {
      const file = join(bdir, backupFileName(at(1, 0, 0, i)));
      makeDb(file, 'old-' + String(i));
    }
    expect(listBackups(bdir)).toHaveLength(9);

    const res = createBackup({
      dataDir: dir,
      dbPath,
      checkpoint: () => {},
      now: () => at(2, 12, 0, 0),
    });

    expect(res.ok).toBe(true);
    expect(DEFAULT_BACKUP_KEEP).toBe(7);
    const left = listBackups(bdir);
    expect(left).toHaveLength(7);
    expect(res.pruned).toBe(3);
    // 最新的那份在，最旧的 3 份被裁掉。
    expect(existsSync(join(bdir, backupFileName(at(2, 12, 0, 0))))).toBe(true);
    expect(existsSync(join(bdir, backupFileName(at(1, 0, 0, 0))))).toBe(false);
    expect(existsSync(join(bdir, backupFileName(at(1, 0, 0, 2))))).toBe(false);
    expect(existsSync(join(bdir, backupFileName(at(1, 0, 0, 3))))).toBe(true);
  });
});

describe('findLatestHealthyBackup', () => {
  it('没有任何备份 → undefined（不抛）', () => {
    const dir = tmpDir();
    expect(findLatestHealthyBackup(backupsDir(dir))).toBeUndefined();
    // 目录都不存在也一样
    expect(findLatestHealthyBackup(join(dir, 'nope'))).toBeUndefined();
  });

  it('最新一个损坏时退到次新的健康备份', () => {
    const dir = tmpDir();
    const bdir = backupsDir(dir);
    const older = join(bdir, backupFileName(at(1, 0, 0, 0)));
    const newer = join(bdir, backupFileName(at(2, 0, 0, 0)));
    makeDb(older, 'good');
    // 新备份写成垃圾字节：打不开，也不该通过 quick_check
    writeFileSync(newer, Buffer.from('this is definitely not a sqlite file'));

    expect(isHealthyDb(newer)).toBe(false);
    expect(isHealthyDb(older)).toBe(true);
    expect(findLatestHealthyBackup(bdir)).toBe(older);
  });

  it('全都损坏 → undefined', () => {
    const dir = tmpDir();
    const bdir = backupsDir(dir);
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, backupFileName(at(1, 0, 0, 0))), 'garbage');
    writeFileSync(join(bdir, backupFileName(at(2, 0, 0, 0))), 'garbage');
    expect(findLatestHealthyBackup(bdir)).toBeUndefined();
  });
});

describe('restoreBackup', () => {
  it('恢复后 dbPath 内容等于备份内容，且 -wal / -shm 已清掉', () => {
    const dir = tmpDir();
    const bdir = backupsDir(dir);
    const dbPath = join(dir, 'clipchan.db');
    const backupPath = join(bdir, backupFileName(at(3, 0, 0, 0)));

    // 备份里是"好数据"
    makeDb(backupPath, 'from-backup');
    // 现库是"别的内容"，并带有会被污染的 sidecar
    makeDb(dbPath, 'current');
    writeFileSync(dbPath + '-wal', 'stale-wal');
    writeFileSync(dbPath + '-shm', 'stale-shm');

    const res = restoreBackup(dbPath, backupPath);

    expect(res.ok).toBe(true);
    expect(res.path).toBe(backupPath);
    expect(readFileSync(dbPath).equals(readFileSync(backupPath))).toBe(true);
    expect(existsSync(dbPath + '-wal')).toBe(false);
    expect(existsSync(dbPath + '-shm')).toBe(false);

    // 恢复出来的库真的能读，且是备份里的那份数据
    const probe = new Database(dbPath, { readonly: true });
    try {
      expect(probe.prepare('SELECT content FROM items WHERE id = ?').get('a'.repeat(32))).toEqual({
        content: 'from-backup',
      });
    } finally {
      probe.close();
    }
  });

  it('备份不存在 → ok:false（missing-backup），不动现库', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');
    makeDb(dbPath, 'current');
    const before = readFileSync(dbPath);

    const res = restoreBackup(dbPath, join(dir, 'nope.db'));

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('missing-backup');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('备份本身损坏 → ok:false（unhealthy-backup），不动现库', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'clipchan.db');
    makeDb(dbPath, 'current');
    const before = readFileSync(dbPath);
    const bad = join(dir, backupFileName(at(3, 0, 0, 0)));
    writeFileSync(bad, 'garbage');

    const res = restoreBackup(dbPath, bad);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('unhealthy-backup');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});

describe('latestBackupTime', () => {
  it('从未备份 → undefined；有备份 → 最新一份的时间戳', () => {
    const dir = tmpDir();
    const bdir = backupsDir(dir);
    expect(latestBackupTime(bdir)).toBeUndefined();

    makeDb(join(bdir, backupFileName(at(1, 0, 0, 0))));
    makeDb(join(bdir, backupFileName(at(4, 0, 0, 0))));
    expect(latestBackupTime(bdir)).toBe(at(4, 0, 0, 0));
  });

  it('接入 shouldBackup：刚备份过就不该再备份', () => {
    const dir = tmpDir();
    const bdir = backupsDir(dir);
    makeDb(join(bdir, backupFileName(at(4, 12, 0, 0))));
    expect(shouldBackup(latestBackupTime(bdir), at(4, 13, 0, 0))).toBe(false);
    expect(shouldBackup(latestBackupTime(bdir), at(5, 13, 0, 0))).toBe(true);
  });
});
