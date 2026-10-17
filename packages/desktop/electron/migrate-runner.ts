/**
 * 旧数据迁移的启动包装（Task 10）。
 *
 * ★ 行为与原先内联在 main.ts 里的那段逐字一致（同一份日志格式、同样的「绝不阻断启动」）：
 *   迁移只在「库是新开的」且 history.json 还在时才尝试；任何异常都只记录，不影响启动。
 * ★ 迁移本身是幂等的（migrate.ts 里 history.json 不存在直接返回全 0），
 *   成功后会改名成 history.json.migrated（不删除），settings.json 只读不动。
 */
import * as fs from 'node:fs';
import { migrateLegacy } from './migrate';
import { legacyHistoryFile } from './paths';
import type { Db } from './db';

export interface MigrationRunResult {
  /** 是否真的尝试过迁移（库不是新的 / 旧文件不在时为 false）。 */
  attempted: boolean;
  /** 导入的条数。 */
  imported: number;
  /** 跳过的条数（缺短键 id/text 的坏记录）。 */
  skipped: number;
  /** 是否从旧 settings.json 读到了主题/自动粘贴。 */
  settingsFromLegacy: boolean;
}

export interface MigrationLog {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export function runLegacyMigration(db: Db, dataDir: string, isFresh: boolean, sink: MigrationLog = {}): MigrationRunResult {
  const log = sink.log ?? ((m: string) => console.log(m));
  const warn = sink.warn ?? ((m: string) => console.warn(m));
  const error = sink.error ?? ((m: string) => console.error(m));
  const empty: MigrationRunResult = { attempted: false, imported: 0, skipped: 0, settingsFromLegacy: false };

  if (!isFresh) return empty;
  if (!fs.existsSync(legacyHistoryFile(dataDir))) return empty;

  try {
    const result = migrateLegacy(db, dataDir, {
      onWarning: (m: string) => warn('[migrate] ' + m),
    });
    log('[migrate] 导入 ' + result.imported + ' 条，跳过 ' + result.skipped + ' 条');
    return {
      attempted: true,
      imported: result.imported,
      skipped: result.skipped,
      settingsFromLegacy: result.settingsFromLegacy,
    };
  } catch (e) {
    error('[migrate] 迁移失败（不阻断启动）：' + String(e));
    return { ...empty, attempted: true };
  }
}
