/**
 * 感知哈希（dHash）——零依赖、平台无关的纯函数模块。
 *
 * 用途：剪贴板图片「相近内容」识别。缩放、重新压缩、轻微曝光变化后
 * 字节内容完全不同（sha256 会判为不同图），但视觉结构不变，dHash 距离很小。
 *
 * 全部实现只依赖 ES 内建对象，不 import 任何东西：
 * 浏览器（WebView）、主进程、vitest 里都能直接跑。
 */

/** 灰度位图：width*height 个 0-255 亮度值，行优先。 */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array | number[];
}

/** dHash 目标网格：宽 9（8 次相邻列比较）、高 8 → 8*8 = 64 位。 */
const GRID_W = 9;
const GRID_H = 8;

/** 每行比较次数 = GRID_W - 1 = 8，与行数 8 相乘正好 64 位。 */
const ROW_BITS = GRID_W - 1;

/** 非法输入时 hammingDistance 的哨兵值（任务书约定的契约）。 */
const INVALID_DISTANCE = 999;

/** 默认相似阈值。 */
const DEFAULT_THRESHOLD = 10;

/** 只接受十六进制字符；空串也在此被判为非法。 */
const HEX_ONLY = /^[0-9a-fA-F]+$/;

/** 把任意数值夹到 [lo, hi] 的整数区间内。 */
function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  const v = Math.trunc(value);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** 读取灰度像素；越界或脏数据一律当 0 处理，绝不返回 NaN/undefined。 */
function readGray(img: GrayImage, x: number, y: number): number {
  const value = img.data[y * img.width + x];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 目标网格第 index 格（共 count 格）在源图 size 个像素上对应的半开区间 [start, end)。
 *
 * ★ 为什么用 floor 做边界：需求定义的目标区域是 [i*size/count, (i+1)*size/count)，
 *   用整数 floor 把浮点边界落到像素下标上，结果确定且与浮点误差无关。
 * ★ 为什么要 clamp 并强制 end >= start + 1：源图小于目标网格时（例如宽 5 → 9 列），
 *   浮点区间宽度会 < 1，直接 floor 会得到空区间甚至越界下标。
 *   这里退化成「至少取 1 个像素」＝最近邻，既保证不越界读，也让极小图有定义。
 */
function sourceSpan(index: number, count: number, size: number): { start: number; end: number } {
  const start = clampInt(Math.floor((index * size) / count), 0, size - 1);
  const rawEnd = clampInt(Math.floor(((index + 1) * size) / count), start + 1, size);
  return { start, end: rawEnd };
}

/**
 * 把灰度图降采样成 9×8 的格子均值（行优先，长度 72）。
 *
 * ★ 为什么用区域平均而不是最近邻取样：最近邻只保留单个采样点，
 *   缩放/重新压缩后采样点落到不同源像素上，哈希会整片翻转；
 *   区域平均把整块像素压成一个均值，对整数倍缩放天然免疫，对压缩噪声也稳定。
 * ★ 复杂度：每个目标格只扫描自己的源区域，所有格子的区域合起来覆盖整幅图，
 *   总读取量 O(源像素数)，不是「每个目标像素重扫全图」的 O(72*W*H)。
 */
function downsampleCells(img: GrayImage): number[] {
  const cells = new Array<number>(GRID_W * GRID_H).fill(0);
  const width = clampInt(img.width, 0, Number.MAX_SAFE_INTEGER);
  const height = clampInt(img.height, 0, Number.MAX_SAFE_INTEGER);
  if (width < 1 || height < 1) return cells;

  for (let ty = 0; ty < GRID_H; ty++) {
    const rows = sourceSpan(ty, GRID_H, height);
    for (let tx = 0; tx < GRID_W; tx++) {
      const cols = sourceSpan(tx, GRID_W, width);
      let sum = 0;
      let count = 0;
      for (let y = rows.start; y < rows.end; y++) {
        for (let x = cols.start; x < cols.end; x++) {
          sum += readGray(img, x, y);
          count++;
        }
      }
      cells[ty * GRID_W + tx] = count > 0 ? sum / count : 0;
    }
  }
  return cells;
}

/**
 * 64 位 dHash，返回 16 个小写十六进制字符。
 *
 * 位序：第 y 行第 x 次比较（x ∈ [0,8)）对应 bit 序号 y*8+x，高位在前打包。
 * 因为每行正好 8 位，实现上就是「每行拼 1 个字节，再按行输出 2 个 hex 字符」。
 * ★ 为什么全黑/全白/纯色图得到 '0000000000000000'：所有相邻列相等，
 *   「左 < 右」全为假 → 64 位全 0。这是正确行为（纯色图本来就没有结构信息），
 *   调用方应把全 0 哈希视为「无结构」，不要拿它做相似匹配的正面证据。
 */
export function dhash(gray: GrayImage): string {
  const cells = downsampleCells(gray);
  let hex = '';
  for (let y = 0; y < GRID_H; y++) {
    let byte = 0;
    for (let x = 0; x < ROW_BITS; x++) {
      const left = cells[y * GRID_W + x] ?? 0;
      const right = cells[y * GRID_W + x + 1] ?? 0;
      byte = (byte << 1) | (left < right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** 4 位掩码里 1 的个数（不用查表，避免 noUncheckedIndexedAccess 带来的 undefined）。 */
function nibblePopcount(value: number): number {
  return (value & 1) + ((value >> 1) & 1) + ((value >> 2) & 1) + ((value >> 3) & 1);
}

/**
 * 两个十六进制哈希的汉明距离；长度不等或含非十六进制字符时返回 999。
 *
 * ★ 为什么用 999 而不是抛异常：调用链在剪贴板写入的热路径上，
 *   一个坏哈希不应该让整次复制失败，哨兵值让上层「当作极不相似」即可。
 * 大小写不敏感（a-f 与 A-F 等价）。
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length === 0 || a.length !== b.length) return INVALID_DISTANCE;
  if (!HEX_ONLY.test(a) || !HEX_ONLY.test(b)) return INVALID_DISTANCE;

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const left = Number.parseInt(a[i] ?? '', 16);
    const right = Number.parseInt(b[i] ?? '', 16);
    distance += nibblePopcount(left ^ right);
  }
  return distance;
}

/**
 * 距离 ≤ 阈值即视为相近。阈值缺省 10。
 *
 * ★ 为什么缺省 10（64 位里允许 15.6% 不同）：实测缩放 + 重压缩 + 轻微曝光的
 *   组合变化通常落在个位数距离，而内容不同的两张图基本都在 20 以上，
 *   10 是两者之间留出的安全带。调用方需要更严/更松时显式传阈值。
 */
export function isSimilar(a: string, b: string, threshold: number = DEFAULT_THRESHOLD): boolean {
  const limit = Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD;
  return hammingDistance(a, b) <= limit;
}

/**
 * 从 RGBA 像素缓冲（每像素 4 字节，行优先）算灰度位图。
 *
 * 亮度权重用标准 ITU-R BT.601：0.299 R + 0.587 G + 0.114 B。
 * ★ 为什么忽略 alpha：剪贴板图片是已经合成好的位图（透明区通常已与背景混合），
 *   再叠一次 alpha 合成反而会把截图/图表里的半透明叠层算错；这里只取颜色亮度。
 * ★ 像素数不足时（rgba.length < width*height*4）不抛异常：能读的像素照常计算，
 *   读不到的尾部保持 0（黑）。输出几何仍等于调用方声明的 width/height，
 *   这样 dhash 不会因为缓冲区短了一截而看到一张尺寸不同的图。
 */
export function rgbaToGray(rgba: Uint8Array | number[], width: number, height: number): GrayImage {
  const w = clampInt(width, 0, Number.MAX_SAFE_INTEGER);
  const h = clampInt(height, 0, Number.MAX_SAFE_INTEGER);
  const total = w * h;
  const data = new Uint8Array(total);
  if (total === 0) return { width: w, height: h, data };

  const availablePixels = Math.floor(rgba.length / 4);
  const pixels = Math.min(total, availablePixels);
  for (let i = 0; i < pixels; i++) {
    const base = i * 4;
    const r = readByte(rgba[base]);
    const g = readByte(rgba[base + 1]);
    const b = readByte(rgba[base + 2]);
    data[i] = clampInt(Math.round(0.299 * r + 0.587 * g + 0.114 * b), 0, 255);
  }
  return { width: w, height: h, data };
}

/** 单个通道取值夹到 [0,255]；缺失/非数值按 0 处理。 */
function readByte(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clampInt(value, 0, 255);
}
