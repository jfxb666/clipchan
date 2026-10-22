import type { UpdateStatus } from '../types';

/**
 * 自动更新的界面文案（v0.6.0 / P0-3）。
 *
 * 主进程只负责把 electron-updater 的事件翻成 UpdateStatus，这里负责翻成人话 ——
 * 两边都不碰对方的职责，才能各自单测。
 */

/** 检查更新按钮上的字：检查中 / 下载中都不允许重复点。 */
export function updateButtonLabel(status: UpdateStatus | null): string {
  if (status === null) return '检查更新';
  switch (status.state) {
    case 'checking':
      return '检查中…';
    case 'downloading':
      return '下载中…';
    case 'downloaded':
      return '重启安装';
    default:
      return '检查更新';
  }
}

/** 按钮是否可点。下载完成时点它做的是「重启安装」，也是可点的。 */
export function canClickUpdate(status: UpdateStatus | null): boolean {
  if (status === null) return true;
  return status.state !== 'checking' && status.state !== 'downloading';
}

/**
 * 状态说明文案。
 * ★ 空态返回空串而不是「已是最新」：还没点过就宣称是最新是骗人。
 */
export function updateStatusText(status: UpdateStatus | null, currentVersion: string): string {
  if (status === null) return '当前版本 ' + currentVersion;
  switch (status.state) {
    case 'idle':
      return '当前版本 ' + currentVersion;
    case 'checking':
      return '正在检查…';
    case 'none':
      return status.message ?? '已是最新版本（' + currentVersion + '）';
    case 'available':
      return status.version ? '发现新版本 ' + status.version + '，正在下载…' : '发现新版本，正在下载…';
    case 'downloading': {
      const percent = typeof status.percent === 'number' ? Math.round(status.percent) : null;
      const base = status.version ? '正在下载 ' + status.version : '正在下载';
      return percent === null ? base + '…' : base + ' ' + percent + '%';
    }
    case 'downloaded':
      return status.version ? '新版本 ' + status.version + ' 已就绪，重启后生效' : '新版本已就绪，重启后生效';
    case 'error':
      return status.message ?? '检查更新失败，请稍后重试';
    default:
      return '当前版本 ' + currentVersion;
  }
}
