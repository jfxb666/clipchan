import { describe, expect, it } from 'vitest';
import type { GrayImage } from './phash';
import { dhash, hammingDistance, isSimilar, rgbaToGray } from './phash';

const HEX16 = /^[0-9a-f]{16}$/;

/** 按坐标生成灰度图；回调返回值会被夹到 0-255 并取整。 */
function makeGray(width: number, height: number, fn: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(fn(x, y));
      data[y * width + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { width, height, data };
}

/** 纯色图。 */
function solid(width: number, height: number, value: number): GrayImage {
  return makeGray(width, height, () => value);
}

/** 每个像素重复 2×（宽高各放大一倍），模拟无损整数倍放大。 */
function upscale2x(img: GrayImage): GrayImage {
  const data = new Uint8Array(img.width * 2 * img.height * 2);
  const w2 = img.width * 2;
  for (let y = 0; y < img.height * 2; y++) {
    for (let x = 0; x < w2; x++) {
      data[y * w2 + x] = img.data[(y >> 1) * img.width + (x >> 1)] ?? 0;
    }
  }
  return { width: w2, height: img.height * 2, data };
}

/** 整体提亮 delta（越界处夹到 255）。 */
function brighten(img: GrayImage, delta: number): GrayImage {
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) {
    const v = (img.data[i] ?? 0) + delta;
    data[i] = v > 255 ? 255 : v < 0 ? 0 : v;
  }
  return { width: img.width, height: img.height, data };
}

/** 固定种子的线性同余伪随机数，保证噪声可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 加入 ±amplitude 的均匀噪声。 */
function addNoise(img: GrayImage, amplitude: number, seed: number): GrayImage {
  const rand = makeRandom(seed);
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) {
    const v = (img.data[i] ?? 0) + Math.round((rand() * 2 - 1) * amplitude);
    data[i] = v > 255 ? 255 : v < 0 ? 0 : v;
  }
  return { width: img.width, height: img.height, data };
}

/** 有结构的测试图：正弦叠加，值域约 28-228，提亮 20 不会截断。 */
function textured(width: number, height: number): GrayImage {
  return makeGray(width, height, (x, y) => 128 + 60 * Math.sin(x / 3) + 40 * Math.cos(y / 2));
}

/** 棋盘图，每格 8px。 */
function checkerboard(width: number, height: number): GrayImage {
  return makeGray(width, height, (x, y) => (((x >> 3) + (y >> 3)) & 1) === 0 ? 20 : 235);
}

/** 左黑右白的阶跃图，宽 18 → 每格恰好 2 列。 */
function stepImage(width: number, height: number): GrayImage {
  return makeGray(width, height, (x) => (x < width / 2 ? 0 : 255));
}

/** 左右渐变图，宽度 18 时每列递增 10。 */
function rampImage(width: number, height: number): GrayImage {
  return makeGray(width, height, (x) => x * 10);
}

describe('dhash：固定输入的确切输出', () => {
  it('左黑右白阶跃图 → 每行 0x18（第 3、4 次比较为 1）', () => {
    // 宽 18 → 每格 2 列；阶跃落在 x=9，正好横跨第 4 格（x=8 黑、x=9 白，均值 127.5），
    // 于是「格3<格4」与「格4<格5」两次比较为 1，其余相等为 0 → 0b00011000 = 0x18。
    expect(dhash(stepImage(18, 8))).toBe('1818181818181818');
  });

  it('水平渐变图 → 全部比较为 1', () => {
    expect(dhash(rampImage(18, 8))).toBe('ffffffffffffffff');
  });

  it('同样的输入永远得到同样的输出（确定性）', () => {
    const img = textured(64, 48);
    expect(dhash(img)).toBe(dhash(img));
  });
});

describe('dhash：纯色图退化为全 0', () => {
  it('全黑 → 0000000000000000', () => {
    expect(dhash(solid(64, 64, 0))).toBe('0000000000000000');
  });

  it('全白 → 0000000000000000', () => {
    expect(dhash(solid(64, 64, 255))).toBe('0000000000000000');
  });

  it('128 灰 → 0000000000000000', () => {
    expect(dhash(solid(32, 32, 128))).toBe('0000000000000000');
  });
});

describe('dhash：输出格式', () => {
  it('返回 16 个小写十六进制字符', () => {
    const hash = dhash(textured(40, 30));
    expect(hash).toHaveLength(16);
    expect(HEX16.test(hash)).toBe(true);
  });

  it('有结构的图哈希非全 0', () => {
    expect(dhash(rampImage(18, 8))).not.toBe('0000000000000000');
  });
});

describe('dhash：左右翻转', () => {
  it('反向渐变的哈希与正向不同', () => {
    const forward = dhash(rampImage(18, 8));
    const backward = dhash(makeGray(18, 8, (x) => (17 - x) * 10));
    expect(backward).not.toBe(forward);
    expect(hammingDistance(forward, backward)).toBeGreaterThan(0);
  });

  it('正向渐变全 1、反向渐变全 0，距离为 64', () => {
    const forward = dhash(rampImage(18, 8));
    const backward = dhash(makeGray(18, 8, (x) => (17 - x) * 10));
    expect(forward).toBe('ffffffffffffffff');
    expect(backward).toBe('0000000000000000');
    expect(hammingDistance(forward, backward)).toBe(64);
  });
});

describe('dhash：亮度与缩放鲁棒性', () => {
  it('整体亮度 +20 后距离 ≤ 阈值（这正是不能用 sha256 的理由）', () => {
    const base = textured(64, 48);
    const distance = hammingDistance(dhash(base), dhash(brighten(base, 20)));
    expect(distance).toBeLessThanOrEqual(10);
  });

  it('整体亮度 +20 后哈希仍是 16 个十六进制字符', () => {
    const bright = dhash(brighten(textured(64, 48), 20));
    expect(bright).toHaveLength(16);
    expect(HEX16.test(bright)).toBe(true);
  });

  it('放大 2×（每像素重复）后哈希完全相同（区域平均对整数倍缩放免疫）', () => {
    const base = textured(18, 16);
    expect(dhash(upscale2x(base))).toBe(dhash(base));
  });

  it('放大 2× 对棋盘图同样免疫', () => {
    const base = checkerboard(36, 24);
    expect(dhash(upscale2x(base))).toBe(dhash(base));
  });

  it('加入 ±3 固定种子噪声后距离 ≤ 阈值', () => {
    const base = textured(64, 48);
    const noisy = addNoise(base, 3, 12345);
    expect(hammingDistance(dhash(base), dhash(noisy))).toBeLessThanOrEqual(10);
  });

  it('噪声可复现：同种子两次得到同一哈希', () => {
    const base = textured(64, 48);
    expect(dhash(addNoise(base, 3, 777))).toBe(dhash(addNoise(base, 3, 777)));
  });
});

describe('dhash：内容不同的图距离大', () => {
  it('棋盘 vs 渐变距离 > 阈值', () => {
    const distance = hammingDistance(dhash(checkerboard(64, 64)), dhash(rampImage(64, 64)));
    expect(distance).toBeGreaterThan(10);
  });

  it('棋盘 vs 纯色距离 > 阈值', () => {
    const distance = hammingDistance(dhash(checkerboard(64, 64)), dhash(solid(64, 64, 128)));
    expect(distance).toBeGreaterThan(10);
  });
});

describe('hammingDistance：契约', () => {
  it("hammingDistance('00', 'ff') = 8", () => {
    expect(hammingDistance('00', 'ff')).toBe(8);
  });

  it("hammingDistance('abcd', 'abcd') = 0", () => {
    expect(hammingDistance('abcd', 'abcd')).toBe(0);
  });

  it("hammingDistance('abc', 'abcd') = 999（长度不等）", () => {
    expect(hammingDistance('abc', 'abcd')).toBe(999);
  });

  it("hammingDistance('zz', '00') = 999（非十六进制字符）", () => {
    expect(hammingDistance('zz', '00')).toBe(999);
  });

  it('空串返回 999', () => {
    expect(hammingDistance('', '')).toBe(999);
    expect(hammingDistance('', '00')).toBe(999);
  });

  it('大小写不敏感', () => {
    expect(hammingDistance('ABCD', 'abcd')).toBe(0);
    expect(hammingDistance('FF', '00')).toBe(8);
  });
});

describe('isSimilar：阈值', () => {
  const zero = '0000000000000000';
  const dist10 = '00000000000003ff';
  const dist11 = '00000000000007ff';

  it('缺省阈值是 10：距离 10 判为相近', () => {
    expect(hammingDistance(zero, dist10)).toBe(10);
    expect(isSimilar(zero, dist10)).toBe(true);
  });

  it('缺省阈值是 10：距离 11 判为不相近', () => {
    expect(hammingDistance(zero, dist11)).toBe(11);
    expect(isSimilar(zero, dist11)).toBe(false);
  });

  it('传自定义阈值生效', () => {
    expect(isSimilar(zero, dist11, 11)).toBe(true);
    expect(isSimilar(zero, dist10, 9)).toBe(false);
    expect(isSimilar(zero, dist10, 0)).toBe(false);
  });

  it('非法哈希永远不相近（999 > 任何正常阈值）', () => {
    expect(isSimilar('abc', 'abcd')).toBe(false);
    expect(isSimilar('zz', '00')).toBe(false);
    // 999 是哨兵，阈值放到 998 仍然判不相近（只有阈值 ≥999 才会把它当距离）。
    expect(isSimilar('zz', '00', 998)).toBe(false);
  });
});

describe('rgbaToGray：亮度权重与容错', () => {
  it('纯红像素 → 0.299*255 ≈ 76', () => {
    const gray = rgbaToGray([255, 0, 0, 255], 1, 1);
    expect(gray.data[0]).toBe(76);
  });

  it('纯绿像素 → 0.587*255 ≈ 150', () => {
    expect(rgbaToGray([0, 255, 0, 255], 1, 1).data[0]).toBe(150);
  });

  it('纯蓝像素 → 0.114*255 ≈ 29', () => {
    expect(rgbaToGray([0, 0, 255, 255], 1, 1).data[0]).toBe(29);
  });

  it('白色 → 255，黑色 → 0', () => {
    expect(rgbaToGray([255, 255, 255, 255], 1, 1).data[0]).toBe(255);
    expect(rgbaToGray([0, 0, 0, 255], 1, 1).data[0]).toBe(0);
  });

  it('忽略 alpha 通道（alpha=0 不影响亮度）', () => {
    expect(rgbaToGray([255, 0, 0, 0], 1, 1).data[0]).toBe(76);
  });

  it('像素数不足时不抛异常，读不到的部分按 0 处理', () => {
    const gray = rgbaToGray([255, 255, 255, 255, 0, 0, 0, 255], 4, 2);
    expect(gray.width).toBe(4);
    expect(gray.height).toBe(2);
    expect(gray.data).toHaveLength(8);
    expect(gray.data[0]).toBe(255);
    expect(gray.data[1]).toBe(0);
    expect(gray.data[7]).toBe(0);
  });

  it('完全空的缓冲也不抛异常', () => {
    const gray = rgbaToGray([], 2, 2);
    expect(gray.data).toHaveLength(4);
    expect(dhash(gray)).toBe('0000000000000000');
  });

  it('端到端：RGBA 渐变图能算出稳定的 16 位哈希', () => {
    const width = 18;
    const height = 8;
    const rgba: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = x * 10;
        rgba.push(v, v, v, 255);
      }
    }
    const hash = dhash(rgbaToGray(rgba, width, height));
    expect(hash).toBe('ffffffffffffffff');
  });
});

describe('dhash：极小图与退化降采样', () => {
  it('1×1 不抛异常且返回 16 字符', () => {
    const hash = dhash(solid(1, 1, 200));
    expect(hash).toHaveLength(16);
    expect(HEX16.test(hash)).toBe(true);
    expect(hash).toBe('0000000000000000');
  });

  it('1×8 不抛异常且返回 16 字符', () => {
    expect(dhash(solid(1, 8, 90))).toHaveLength(16);
  });

  it('9×1 不抛异常且返回 16 字符', () => {
    expect(dhash(makeGray(9, 1, (x) => x * 20))).toHaveLength(16);
  });

  it('宽 4（<9）时正常降采样且不越界', () => {
    const hash = dhash(makeGray(4, 8, (x) => x * 60));
    expect(hash).toHaveLength(16);
    expect(HEX16.test(hash)).toBe(true);
  });

  it('高 3（<8）时正常降采样且不越界', () => {
    const hash = dhash(makeGray(16, 3, (x) => x * 15));
    expect(hash).toHaveLength(16);
    expect(HEX16.test(hash)).toBe(true);
  });

  it('宽 1 的竖条图：所有比较都是相等 → 全 0', () => {
    expect(dhash(makeGray(1, 16, () => 77))).toBe('0000000000000000');
  });

  it('极小图退化区域平均为最近邻：5×5 与放大后仍得到 16 字符', () => {
    const tiny = textured(5, 5);
    expect(dhash(tiny)).toHaveLength(16);
    expect(dhash(upscale2x(tiny))).toHaveLength(16);
  });

  it('宽度或高度为 0 的畸形输入不抛异常', () => {
    expect(dhash({ width: 0, height: 0, data: [] })).toBe('0000000000000000');
    expect(dhash({ width: 0, height: 4, data: [] })).toBe('0000000000000000');
  });
});
