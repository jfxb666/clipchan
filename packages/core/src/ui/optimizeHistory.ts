import type { OptimizeHistoryEntry } from '../types';
import { dayKeyOf } from './timeline';

/**
 * 优化历史抽屉的纯函数（v0.5.0）。与 optimizeView.ts 同一处理：
 * 抽屉里所有可测逻辑放这里，组件只管渲染。
 */

/** 与主进程 trimOptimizeHistory 的保留条数一致：超出淘汰最旧。 */
export const HISTORY_LIMIT = 100;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 时间戳 → 列表里的一行时间。
 * ★ 与 timeline.dayLabelOf 同风格，但必须带 HH:mm：优化历史可能同一天里几十条，
 *   只写「今天」就分不出先后。
 */
export function historyTimeLabel(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const key = dayKeyOf(ts);
  if (key === dayKeyOf(now)) return clock;
  if (key === dayKeyOf(now - 86400000)) return '昨天 ' + clock;
  const day = d.getMonth() + 1 + '月' + d.getDate() + '日';
  if (d.getFullYear() === new Date(now).getFullYear()) return day + ' ' + clock;
  return d.getFullYear() + '年' + day + ' ' + clock;
}

/**
 * 场景名。查不到就回落 sceneId：场景被删掉之后，历史条目仍要能看懂是哪一类，
 * 而 id 至少是可对照的原始信息（渲染层不能凭空造一个「未知场景」把它藏掉）。
 */
export function historySceneLabel(
  entry: OptimizeHistoryEntry,
  scenes: { id: string; name: string }[],
): string {
  const hit = scenes.find((scene) => scene.id === entry.sceneId);
  return hit ? hit.name : entry.sceneId;
}

/**
 * 列表里的一行摘要。
 * ★ 先压空白再截断：原文是多行提示词，不压成一行会把列表项撑成方块，
 *   而且换行符也算进长度会让截断位置飘。
 */
export function truncateForList(text: string, n: number = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

export function emptyHistoryHint(): string {
  return '还没有优化记录';
}
