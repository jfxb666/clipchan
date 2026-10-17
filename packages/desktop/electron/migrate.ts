/**
 * 旧版数据迁移（spec §9.3）。
 *
 * ★★ 最大的陷阱：旧文件用的是**短键**，不是 C# 属性名。
 *   history.json  -> { version: 1, items: [ { id, text, at, seq, pin, trunc } ] }
 *   settings.json -> { ctrl, alt, shift, win, key, theme, autopaste, label }
 * 如果按 C# 属性名（`CreatedUtc` / `Pinned` / `Truncated`）去解析，会**静默导空**——
 * 一条都不报错、一条也导不进来。migrate.spec.ts 里专门写了一条测试把这个陷阱钉住。
 *
 * 其它硬要求：
 * - 单事务：条目插入 + 设置写入一起提交；部分条目失败只跳过并计数，不整体回滚。
 * - 成功后 `history.json` 改名为 `history.json.migrated`（**不删**）。
 * - `settings.json` 只读：不写回、不改名、字节不变（spec §9.4 明确不写任何 settings.json）。
 * - `kind` 用 core 的 classify 重算（旧版没有 kind 字段）。
 * - `seq` 缺失按"当前已知最大 seq + 1"补（等价于旧版 ClipItem.NextSeq()）。
 */
import * as fs from 'node:fs';
import { classify } from '@clipchan/core';
import { hashText, TEXT_LIMIT, type Db } from './db';
import { legacyHistoryFile, legacySettingsFile, migratedHistoryFile } from './paths';

/** 迁移结果。`skipped > 0` 时设置页要提示"有 N 条未能导入"。 */
export interface MigrateResult {
  imported: number;
  skipped: number;
  /** 是否从旧 settings.json 读到了主题 / 自动粘贴（热键不翻译，一律用新版默认值）。 */
  settingsFromLegacy: boolean;
}

export interface MigrateOpts {
  /** 警告回调（at 解析失败、条目跳过等）。缺省走 console.warn。 */
  onWarning?: (message: string) => void;
}

/** 旧版历史文件里的一条：**短键**。全部按 unknown 收，逐个校验。 */
interface LegacyItem {
  id?: unknown;
  text?: unknown;
  at?: unknown;
  seq?: unknown;
  pin?: unknown;
  trunc?: unknown;
}

interface LegacyHistory {
  version?: unknown;
  items?: unknown;
}

interface LegacySettings {
  ctrl?: unknown;
  alt?: unknown;
  shift?: unknown;
  win?: unknown;
  key?: unknown;
  theme?: unknown;
  autopaste?: unknown;
  label?: unknown;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

/** 宽松的正整数解析：旧文件里 seq 可能是数字、字符串，也可能缺。 */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * 把旧版 `history.json` 导入库，并读取旧 `settings.json` 的 theme / autopaste。
 *
 * 前置条件（调用方保证）：`clipchan.db` 原本不存在，且 `history.json` 存在。
 * 函数自身是幂等的：`history.json` 不存在（例如已迁移过）时直接返回全 0。
 */
export function migrateLegacy(db: Db, dir: string, opts: MigrateOpts = {}): MigrateResult {
  const warn = opts.onWarning ?? ((m: string) => console.warn('[migrate] ' + m));
  const result: MigrateResult = { imported: 0, skipped: 0, settingsFromLegacy: false };

  const historyPath = legacyHistoryFile(dir);
  if (!fs.existsSync(historyPath)) return result; // 没有旧数据，或已经迁移过

  let history: LegacyHistory;
  try {
    history = readJson(historyPath) as LegacyHistory;
  } catch (e) {
    // 文件损坏：不动它（旧版会另存 .bad，这里保守处理，留给人工）。
    warn('history.json 解析失败，已跳过迁移：' + String(e));
    return result;
  }

  const items: LegacyItem[] = Array.isArray(history?.items) ? (history.items as LegacyItem[]) : [];

  // 已存在的最大 seq（正常情况下库是空的；重复调用时也能接着涨）。
  let maxSeq = (db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM items').get() as { m: number }).m;

  const insert = db.raw.prepare(
    `INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq)
     VALUES (?, ?, ?, ?, 'clip', ?, ?, ?, ?)`,
  );

  const run = db.raw.transaction(() => {
    for (const raw of items) {
      const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
      const text = typeof raw?.text === 'string' ? raw.text.replace(/\0/g, '') : null;

      // ★ 短键缺失（例如文件里写的是 Text / Id）→ 跳过。绝不"猜"别的键名。
      if (id.length === 0 || text === null || text.length === 0) {
        result.skipped++;
        warn('跳过一条：缺少短键 id/text');
        continue;
      }

      const parsedAt = typeof raw?.at === 'string' ? Date.parse(raw.at) : NaN;
      if (!Number.isFinite(parsedAt)) {
        // 计划 Task 2 第 9 步：at 解析失败的条目只跳过并计入 skipped，其余照常导入。
        // （spec §9.3 写的是"用当前时间并记警告"，此处按计划的验收口径实现，并向 lead 报备。）
        result.skipped++;
        warn('跳过一条：at 无法解析 ' + JSON.stringify(raw.at));
        continue;
      }

      let content = text;
      let truncated = raw?.trunc === true;
      if (content.length > TEXT_LIMIT) {
        content = content.slice(0, TEXT_LIMIT);
        truncated = true;
      }

      const seqRaw = asPositiveInt(raw?.seq);
      let seq: number;
      if (seqRaw === null) {
        maxSeq = maxSeq + 1;
        seq = maxSeq;
      } else {
        seq = seqRaw;
        if (seq > maxSeq) maxSeq = seq;
      }

      const pinned = raw?.pin === true;
      const kind = classify(content);
      try {
        insert.run(id, kind, content, hashText(content), pinned ? 1 : 0, truncated ? 1 : 0, parsedAt, seq);
        result.imported++;
      } catch (e) {
        // 主键冲突（重复 id）或 content_hash 唯一索引冲突（重复内容）→ 只跳过这一条。
        result.skipped++;
        warn('跳过一条（' + id + '）：' + String(e));
      }
    }

    // 旧 settings.json：只读 theme / autopaste；热键数值不翻译（新版默认 Ctrl+`），label 忽略。
    const settingsPath = legacySettingsFile(dir);
    if (fs.existsSync(settingsPath)) {
      try {
        const legacy = readJson(settingsPath) as LegacySettings;
        const patch: { theme?: unknown; autoPaste?: unknown } = {};
        if (typeof legacy?.theme === 'string') patch.theme = legacy.theme;
        if (typeof legacy?.autopaste === 'boolean') patch.autoPaste = legacy.autopaste;
        if (patch.theme !== undefined || patch.autoPaste !== undefined) {
          db.setSettings(patch as { theme?: never; autoPaste?: never });
          result.settingsFromLegacy = true;
        }
      } catch (e) {
        warn('settings.json 读取失败，设置保持新版默认值：' + String(e));
      }
    }
  });

  run();

  // 迁移成功（事务已提交）后才改名留档；不删文件。
  try {
    fs.renameSync(historyPath, migratedHistoryFile(dir));
  } catch (e) {
    warn('history.json 改名失败（数据已导入）：' + String(e));
  }

  return result;
}
