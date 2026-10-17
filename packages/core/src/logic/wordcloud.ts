/**
 * 今日词云的分词与统计。移植自 legacy/src/WordCloudForm.cs 的六个纯函数
 * （ExtractCjkWords / TrimParticles / LatinWords / CjkRuns / IsCjk / StopWords），
 * 界面部分不移植——新版词云是应用内视图，不是独立窗口。
 */

/** 常被误当词首尾的虚词/单字。 */
const PARTICLES = '的了是这那我们你们他们和与或及而在就都也很把被给对为个之其';

/** 常见停用词：中英文混排。 */
const STOP_WORDS = new Set<string>([
  '的', '了', '是', '我', '你', '他', '她', '它', '这', '那', '有', '在', '和', '就', '都', '而', '及', '与', '或', '一个', '我们', '你们', '他们',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'and', 'in', 'on', 'at', 'for', 'with',
  'it', 'this', 'that', 'i', 'you', 'he', 'she', 'we', 'they', 'not', 'but', 'have', 'has', 'do', 'does',
]);

export function isCjk(c: string): boolean {
  const n = c.codePointAt(0)!;
  return (n >= 0x4e00 && n <= 0x9fff) || (n >= 0x3040 && n <= 0x30ff) || (n >= 0xac00 && n <= 0xd7af);
}

/** 切出文本中的连续 CJK 片段。 */
export function cjkRuns(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const cjk = i < text.length && isCjk(text[i]!);
    if (cjk) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push(text.slice(start, i));
      start = -1;
    }
  }
  return out;
}

/** 去掉中文词首尾的虚词（"的""了""是"等）。 */
export function trimParticles(w: string): string {
  let start = 0;
  let end = w.length;
  while (start < end && PARTICLES.includes(w[start]!)) start++;
  while (end > start && PARTICLES.includes(w[end - 1]!)) end--;
  return w.slice(start, end);
}

/** 英文/数字词：按非字母数字切分并小写化。 */
export function latinWords(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.length >= 2 && !STOP_WORDS.has(buf)) out.push(buf);
    buf = '';
  };
  for (const c of text) {
    const isAlnum = /[0-9A-Za-z]/.test(c) || (/[\p{L}\p{N}]/u.test(c) && !isCjk(c));
    if (isAlnum) buf += c.toLowerCase();
    else if (buf.length > 0) flush();
  }
  if (buf.length > 0) flush();
  return out;
}

/**
 * 中文分词（无词典）：从所有 CJK 片段里发现重复出现的词。
 * 统计 2~4 字 n-gram 频次 → 按"长度² × 频次"降序 → 贪心抠掉已选片段避免子串碎片重复入选。
 */
export function extractCjkWords(runs: string[]): Map<string, number> {
  const grams = new Map<string, number>();
  for (const run of runs) {
    const maxLen = Math.min(4, run.length);
    for (let len = 2; len <= maxLen; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const g = run.slice(i, i + len);
        grams.set(g, (grams.get(g) ?? 0) + 1);
      }
    }
  }

  const candidates: string[] = [];
  for (const [g, n] of grams) {
    if (n < 2) continue;
    if (STOP_WORDS.has(g)) continue;
    candidates.push(g);
  }

  candidates.sort((a, b) => {
    const sa = a.length * a.length * (grams.get(a) ?? 0);
    const sb = b.length * b.length * (grams.get(b) ?? 0);
    if (sb !== sa) return sb - sa;
    if (b.length !== a.length) return b.length - a.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const result = new Map<string, number>();
  const taken: boolean[][] = runs.map((r) => new Array<boolean>(r.length).fill(false));

  for (const cand of candidates) {
    const hits: [number, number][] = [];
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]!;
      for (let i = 0; i + cand.length <= run.length; i++) {
        if (run.slice(i, i + cand.length) !== cand) continue;
        let free = true;
        for (let k = 0; k < cand.length; k++) {
          if (taken[r]![i + k]) { free = false; break; }
        }
        if (free) hits.push([r, i]);
      }
    }
    if (hits.length < 2) continue;
    const word = trimParticles(cand);
    if (word.length < 2) continue;
    result.set(word, (result.get(word) ?? 0) + hits.length);
    for (const [r, i] of hits) {
      for (let k = 0; k < cand.length; k++) taken[r]![i + k] = true;
    }
    if (result.size >= 30) break;
  }
  return result;
}

/** 把一批文本统计成词云数据（词 + 权重，按权重降序）。 */
export function buildWordCloud(texts: string[]): { word: string; weight: number }[] {
  const counts = new Map<string, number>();
  const runs: string[] = [];
  for (const t of texts) {
    for (const r of cjkRuns(t)) runs.push(r);
  }
  for (const [w, n] of extractCjkWords(runs)) {
    counts.set(w, (counts.get(w) ?? 0) + n);
  }
  for (const t of texts) {
    for (const w of latinWords(t)) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, weight]) => ({ word, weight }))
    .sort((a, b) => (b.weight - a.weight) || (b.word.length - a.word.length) || (a.word < b.word ? -1 : 1));
}
