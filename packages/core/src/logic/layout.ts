/**
 * 词云布局（spec §6.9；计划 Task 9）。
 *
 * 算法：词按权重降序 → 字号由权重比例决定 → 从区域中心出发走**阿基米德螺旋**。
 * 旧版对应实现是 legacy/src/WordCloudForm.cs:531 EnsureLayout（防重叠布局）。
 */

export interface LayoutWord { word: string; weight: number; }
export interface LayoutArea { w: number; h: number; }
export interface PlacedWord {
  word: string; weight: number; x: number; y: number; w: number; h: number; fontSize: number;
}
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 44;
const BASE_FONT_SIZE = 14;
const GAP = 2;
const PADDING = 4;
const SPIRAL_ANGLE_STEP = 0.28;
const SPIRAL_RADIUS_STEP = 1.6;
const MAX_SPIRAL_STEPS = 6000;
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += isWideChar(ch) ? 1 : 0.55;
  return Math.max(fontSize, Math.round(units * fontSize));
}
function isWideChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf);
}
function boxOf(word: string, fontSize: number): { w: number; h: number } {
  return { w: estimateTextWidth(word, fontSize) + PADDING * 2, h: Math.round(fontSize * 1.25) + PADDING };
}
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  gap = GAP,
): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
function insideArea(r: { x: number; y: number; w: number; h: number }, area: LayoutArea): boolean {
  return r.x >= PADDING && r.y >= PADDING && r.x + r.w <= area.w - PADDING && r.y + r.h <= area.h - PADDING;
}
export function layoutWords(words: LayoutWord[], area: LayoutArea): PlacedWord[] {
  const w = Math.max(0, Math.floor(area.w));
  const h = Math.max(0, Math.floor(area.h));
  if (w === 0 || h === 0 || words.length === 0) return [];
  const usable = words.filter((it) => typeof it.word === 'string' && it.word.length > 0)
    .map((it) => ({ word: it.word, weight: Number.isFinite(it.weight) && it.weight > 0 ? it.weight : 0 }));
  if (usable.length === 0) return [];
  const sorted = [...usable].sort((a, b) => b.weight - a.weight || b.word.length - a.word.length || (a.word < b.word ? -1 : 1));
  const maxWeight = sorted[0]?.weight ?? 0;
  const minWeight = sorted[sorted.length - 1]?.weight ?? 0;
  const span = Math.max(1, maxWeight - minWeight);
  const placed: PlacedWord[] = [];
  for (const item of sorted) {
    const ratio = maxWeight > 0 ? (item.weight - minWeight) / span : 0;
    const initial = Math.round(BASE_FONT_SIZE + ratio * (MAX_FONT_SIZE - BASE_FONT_SIZE));
    let fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, initial));
    let hit: PlacedWord | null = null;
    while (fontSize >= MIN_FONT_SIZE && hit === null) {
      const box = boxOf(item.word, fontSize);
      const spot = spiralSearch(box, area, placed);
      if (spot) hit = { word: item.word, weight: item.weight, x: spot.x, y: spot.y, w: box.w, h: box.h, fontSize };
      else fontSize -= 1;
    }
    if (hit) placed.push(hit);
  }
  return placed;
}
function spiralSearch(box: { w: number; h: number }, area: LayoutArea, placed: PlacedWord[]): { x: number; y: number } | null {
  const cx = (area.w - box.w) / 2;
  const cy = (area.h - box.h) / 2;
  let angle = 0;
  let radius = 0;
  for (let step = 0; step < MAX_SPIRAL_STEPS; step += 1) {
    const x = Math.round(cx + Math.cos(angle) * radius);
    const y = Math.round(cy + Math.sin(angle) * radius);
    const rect = { x, y, w: box.w, h: box.h };
    if (insideArea(rect, area) && placed.every((p) => !rectsOverlap(rect, p))) return { x, y };
    angle += SPIRAL_ANGLE_STEP;
    radius += SPIRAL_RADIUS_STEP * (SPIRAL_ANGLE_STEP / (2 * Math.PI));
  }
  return null;
}
