/**
 * 今日词云数据（spec §6.9；计划 Task 9 步骤 ⑤）。
 *
 * 统计范围（Lead 已定，spec §6.9）：
 * - **本地日历日**：当天 00:00 至当前时刻（系统时区），不是"最近 24 小时"；
 * - 只算**文本类**（kind != 'image' 且 content 非空），图片不参与；
 * - 收藏与未收藏都算，source='merge' 的拼接结果也算。
 * ★ 本文件不 import electron，可在 Node 里单测。
 */
import { buildWordCloud, type WordCloudData } from '@clipchan/core';
import type { Db } from './db';

/** 本地日历日零点的时间戳。 */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 取当天参与统计的文本（按时间升序，顺序不影响词频）。 */
export function collectTodayTexts(db: Db, now: number = Date.now()): string[] {
  const from = startOfLocalDay(now);
  const rows = db.raw
    .prepare(
      "SELECT content FROM items WHERE kind != 'image' AND content IS NOT NULL AND created_at >= ? ORDER BY created_at ASC, seq ASC",
    )
    .all(from) as { content: string | null }[];
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r.content === 'string' && r.content.length > 0) out.push(r.content);
  }
  return out;
}

/** 今日词云：词表按权重降序（buildWordCloud 已排序），totalItems 是参与统计的记录条数。 */
export function wordCloudToday(db: Db, now: number = Date.now()): WordCloudData {
  const texts = collectTodayTexts(db, now);
  return { words: buildWordCloud(texts), totalItems: texts.length };
}
