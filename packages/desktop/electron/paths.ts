/**
 * 数据目录与路径工具。
 *
 * ★ 本文件是**纯函数模块**，不 import electron —— 这样能在 Node / vitest 里直接单测。
 * 调用方负责把 app.getPath('appData') 传进来（Electron 的 app 在测试环境里拿不到）。
 */
import * as path from 'node:path';

/** 数据目录名。spec §9.1：目录名保持 Clipchan，旧用户的数据原地可迁移。 */
export const DATA_DIR_NAME = 'Clipchan';

/** 主数据库文件名。 */
export const DB_FILE_NAME = 'clipchan.db';
/** 旧版历史文件（迁移源，迁移后改名留档）。 */
export const LEGACY_HISTORY_NAME = 'history.json';
/** 旧版配置文件：新版**只读不写**，见 spec §9.4。 */
export const LEGACY_SETTINGS_NAME = 'settings.json';
/** 原图子目录。 */
export const IMAGES_DIR_NAME = 'images';
/** 缩略图子目录。 */
export const THUMBS_DIR_NAME = 'thumbs';

/**
 * 由「基目录」推出数据目录。
 *
 * 基目录通常是 `app.getPath('appData')`（%APPDATA%），结果为 %APPDATA%\Clipchan。
 * 若传入的已经是 Clipchan 目录本身，则原样返回（幂等，避免出现 Clipchan\Clipchan）。
 */
export function resolveDataDir(base: string): string {
  const trimmed = (base ?? '').trim();
  if (trimmed.length === 0) throw new Error('resolveDataDir: base 路径不能为空');
  const normalized = path.normalize(trimmed);
  if (path.basename(normalized).toLowerCase() === DATA_DIR_NAME.toLowerCase()) return normalized;
  return path.join(normalized, DATA_DIR_NAME);
}

/**
 * 把库里的**相对路径**（如 `images/abc.jpg`）解析成绝对路径。
 * 绝对路径原样返回（兼容外部注入的行）。
 */
export function imageAbs(dataDir: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('imageAbs: 相对路径不能为空');
  }
  return path.isAbsolute(relPath) ? path.normalize(relPath) : path.join(dataDir, relPath);
}

/**
 * 把绝对路径转成相对数据目录的路径，并统一用 `/` 分隔符入库。
 * ★ 库里一律存相对路径（spec §9.2），这样换机器 / 换用户名也能用。
 */
export function toRelativePath(dataDir: string, absPath: string): string {
  const rel = path.relative(dataDir, absPath);
  return rel.split(path.sep).join('/');
}

/** 原图目录：<dataDir>/images */
export function imagesDir(dataDir: string): string {
  return path.join(dataDir, IMAGES_DIR_NAME);
}

/** 缩略图目录：<dataDir>/thumbs */
export function thumbsDir(dataDir: string): string {
  return path.join(dataDir, THUMBS_DIR_NAME);
}

/** 数据库文件：<dataDir>/clipchan.db */
export function dbFile(dataDir: string): string {
  return path.join(dataDir, DB_FILE_NAME);
}

/** 旧版历史文件：<dataDir>/history.json */
export function legacyHistoryFile(dataDir: string): string {
  return path.join(dataDir, LEGACY_HISTORY_NAME);
}

/** 迁移后的留档文件：<dataDir>/history.json.migrated（不删，spec §9.3 第 6 步） */
export function migratedHistoryFile(dataDir: string): string {
  return legacyHistoryFile(dataDir) + '.migrated';
}

/** 旧版配置文件：<dataDir>/settings.json（新版只读） */
export function legacySettingsFile(dataDir: string): string {
  return path.join(dataDir, LEGACY_SETTINGS_NAME);
}
