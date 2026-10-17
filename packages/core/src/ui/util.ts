import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并类名：clsx 处理条件拼接，tailwind-merge 处理同类冲突（px-2 与 px-4 只留后者）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/**
 * 时间戳 → 中文短时间。
 * 今天只显示 HH:mm，昨天带前缀，同年显示月日，跨年补上年份。
 */
export function formatTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay(d, today)) return hh + ':' + mm;
  if (sameDay(d, new Date(now - 86400000))) return '昨天 ' + hh + ':' + mm;
  if (d.getFullYear() === today.getFullYear()) return d.getMonth() + 1 + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/** 剩余毫秒 → 「N 分钟」（幽灵模式倒计时用；不足 1 分钟单独给一句）。 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '不到 1 分钟';
  return Math.ceil(ms / 60000) + ' 分钟';
}

/** 把 sizeLabel（「12 KB」「1.5 MB」）换算成 MB，用于历史分区的占用估算。 */
export function sizeLabelToMB(label?: string): number {
  if (!label) return 0;
  const matched = /([\d.]+)\s*(B|KB|MB|GB)/i.exec(label);
  if (!matched) return 0;
  const value = Number(matched[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (matched[2] ?? 'B').toUpperCase();
  if (unit === 'GB') return value * 1024;
  if (unit === 'MB') return value;
  if (unit === 'KB') return value / 1024;
  return value / (1024 * 1024);
}

/** 毫秒时间戳 → HH:mm:ss（幽灵模式结束时间展示用）。 */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0')
  );
}
