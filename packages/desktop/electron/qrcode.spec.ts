/**
 * 二维码解码的用例（qrcode.ts 验收）。
 *
 * ★ 全程不碰真实图片、不依赖 jsqr 能解出码：解码器从 QrDeps.decode 注入替身，
 *   所以本文件不需要任何二维码素材，也不会因为 jsqr 版本差异变红。
 * ★ 唯一一条真跑 jsqr 的用例只验证「默认解码器确实接上了、且不会抛」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bgraToRgba, createQr, fitBitmap } from './qrcode';
import type { QrImageLike } from './qrcode';

/** 一次 decode 调用的快照（含拿到的字节，用来验通道顺序）。 */
interface DecodeCall {
  data: Uint8Array;
  width: number;
  height: number;
}

/** decode 替身：记下每次入参，行为由 impl 决定。 */
function spyDecode(impl: (data: Uint8Array, width: number, height: number) => string | null) {
  const calls: DecodeCall[] = [];
  const fn = (data: Uint8Array, width: number, height: number): string | null => {
    calls.push({ data, width, height });
    return impl(data, width, height);
  };
  return { fn, calls };
}

/** 造一个像素全为同一个 BGRA 值的位图（长度 = w*h*4）。 */
function bitmap(w: number, h: number, pixel: [number, number, number, number] = [10, 20, 30, 255]): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    buf[i * 4] = pixel[0];
    buf[i * 4 + 1] = pixel[1];
    buf[i * 4 + 2] = pixel[2];
    buf[i * 4 + 3] = pixel[3];
  }
  return buf;
}

/** 带 toBitmap 的假图片。 */
function imageWithBitmap(
  bmp: Buffer,
  size: { width: number; height: number } = { width: 2, height: 2 },
): QrImageLike {
  return { isEmpty: () => false, getSize: () => size, toBitmap: () => bmp };
}

/** 没有 toBitmap 的假图片（模拟「注入方只给尺寸」）。 */
function imageWithoutBitmap(): QrImageLike {
  return { isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }) };
}

const SIZE_2X2 = { width: 2, height: 2 };
const PIXELS_2X2 = 2 * 2 * 4;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recognize：正常路径', () => {
  it('注入的 decode 返回文本 → recognize 返回同一文本', async () => {
    const { fn } = spyDecode(() => 'https://example.com/abc');
    const qr = createQr({ loadImage: () => imageWithBitmap(bitmap(2, 2)), decode: fn });
    await expect(qr.recognize('C:\\tmp\\a.png')).resolves.toBe('https://example.com/abc');
  });

  it('decode 拿到的宽高就是 getSize 的宽高', async () => {
    const { fn, calls } = spyDecode(() => null);
    const bmp = bitmap(7, 5);
    const qr = createQr({
      loadImage: () => imageWithBitmap(bmp, { width: 7, height: 5 }),
      decode: fn,
    });
    await qr.recognize('x.png');
    expect(calls.map((c) => c.width)).toEqual([7, 7]);
    expect(calls.map((c) => c.height)).toEqual([5, 5]);
  });

  it('loadImage 收到的就是传进来的路径', async () => {
    const seen: string[] = [];
    const qr = createQr({
      loadImage: (p) => {
        seen.push(p);
        return imageWithBitmap(bitmap(2, 2));
      },
      decode: () => 'TEXT',
    });
    await qr.recognize('C:\\imgs\\q.png');
    expect(seen).toEqual(['C:\\imgs\\q.png']);
  });
});

describe('recognize：拿不到图 / 拿不到像素', () => {
  it('loadImage 返回 null → 返回空串，不抛', async () => {
    const qr = createQr({ loadImage: () => null, decode: () => 'X' });
    await expect(qr.recognize('missing.png')).resolves.toBe('');
  });

  it('loadImage 抛异常 → 返回空串，不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qr = createQr({
      loadImage: () => {
        throw new Error('EACCES');
      },
      decode: () => 'X',
    });
    await expect(qr.recognize('denied.png')).resolves.toBe('');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('[qr] ');
  });

  it('loadImage 返回 isEmpty() === true 的图 → 返回空串', async () => {
    const qr = createQr({
      loadImage: () => ({ isEmpty: () => true, getSize: () => SIZE_2X2, toBitmap: () => bitmap(2, 2) }),
      decode: () => 'X',
    });
    await expect(qr.recognize('blank.png')).resolves.toBe('');
  });

  it('getSize 抛异常 → 返回空串，不抛', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qr = createQr({
      loadImage: () => ({
        isEmpty: () => false,
        getSize: () => {
          throw new Error('boom');
        },
        toBitmap: () => bitmap(2, 2),
      }),
      decode: () => 'X',
    });
    await expect(qr.recognize('x.png')).resolves.toBe('');
  });

  it('宽或高为 0 → 返回空串（不去调 decode）', async () => {
    const { fn, calls } = spyDecode(() => 'X');
    const qr = createQr({
      loadImage: () => imageWithBitmap(bitmap(2, 2), { width: 0, height: 2 }),
      decode: fn,
    });
    await expect(qr.recognize('x.png')).resolves.toBe('');
    expect(calls.length).toBe(0);
  });

  it('toBitmap 缺失（undefined）且无 prepare → 返回空串', async () => {
    const { fn, calls } = spyDecode(() => 'X');
    const qr = createQr({ loadImage: () => imageWithoutBitmap(), decode: fn });
    await expect(qr.recognize('x.png')).resolves.toBe('');
    expect(calls.length).toBe(0);
  });

  it('toBitmap 抛异常且无 prepare → 返回空串，不抛', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qr = createQr({
      loadImage: () => ({
        isEmpty: () => false,
        getSize: () => SIZE_2X2,
        toBitmap: () => {
          throw new Error('bitmap failed');
        },
      }),
      decode: () => 'X',
    });
    await expect(qr.recognize('x.png')).resolves.toBe('');
  });

  it('toBitmap 返回空 Buffer → 返回空串', async () => {
    const { fn, calls } = spyDecode(() => 'X');
    const qr = createQr({ loadImage: () => imageWithBitmap(Buffer.alloc(0)), decode: fn });
    await expect(qr.recognize('x.png')).resolves.toBe('');
    expect(calls.length).toBe(0);
  });
});

describe('recognize：prepare 与 toBitmap 的优先级', () => {
  it('prepare 有像素时优先用它（decode 第一轮收到的是 prepare 的字节）', async () => {
    const prepared = new Uint8Array(PIXELS_2X2).fill(77);
    const { fn, calls } = spyDecode((data) => (data[0] === 77 ? 'FROM_PREPARE' : null));
    const qr = createQr({
      loadImage: () => imageWithBitmap(bitmap(2, 2)),
      prepare: () => ({ data: prepared }),
      decode: fn,
    });
    await expect(qr.recognize('x.png')).resolves.toBe('FROM_PREPARE');
    expect(calls.length).toBe(1);
    expect(calls.map((c) => Array.from(c.data.slice(0, 1)))).toEqual([[77]]);
  });

  it('prepare 返回 null → 退回 toBitmap', async () => {
    const { fn, calls } = spyDecode(() => 'FROM_BITMAP');
    const qr = createQr({
      loadImage: () => imageWithBitmap(bitmap(2, 2)),
      prepare: () => null,
      decode: fn,
    });
    await expect(qr.recognize('x.png')).resolves.toBe('FROM_BITMAP');
    expect(calls.length).toBe(1);
  });

  it('prepare 抛异常 → 退回 toBitmap 路径（不整体失败）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qr = createQr({
      loadImage: () => imageWithBitmap(bitmap(2, 2)),
      prepare: () => {
        throw new Error('resize failed');
      },
      decode: () => 'FROM_BITMAP',
    });
    await expect(qr.recognize('x.png')).resolves.toBe('FROM_BITMAP');
    expect(warn.mock.calls.length).toBeGreaterThan(0);
  });

  it('prepare 返回空字节 → 当作没给，退回 toBitmap', async () => {
    const qr = createQr({
      loadImage: () => imageWithBitmap(bitmap(2, 2)),
      prepare: () => ({ data: new Uint8Array(0) }),
      decode: () => 'FROM_BITMAP',
    });
    await expect(qr.recognize('x.png')).resolves.toBe('FROM_BITMAP');
  });
});

describe('recognize：两条通道（RGBA 直喂 → BGRA 换序）', () => {
  it('第一次 decode 返回 null、第二次返回文本 → 最终返回文本', async () => {
    const { fn, calls } = spyDecode((_data, _w, _h) => (calls.length === 1 ? null : 'SECOND_PASS'));
    const qr = createQr({ loadImage: () => imageWithBitmap(bitmap(2, 2)), decode: fn });
    await expect(qr.recognize('x.png')).resolves.toBe('SECOND_PASS');
    expect(calls.length).toBe(2);
  });

  it('第一条通道按原样直喂、第二条才换序（B/R 对调）', async () => {
    // 位图每像素 BGRA = [10,20,30,255]，换序后应是 RGBA = [30,20,10,255]。
    const { fn, calls } = spyDecode(() => null);
    const qr = createQr({ loadImage: () => imageWithBitmap(bitmap(2, 2)), decode: fn });
    await qr.recognize('x.png');
    expect(calls.map((c) => Array.from(c.data.slice(0, 4)))).toEqual([
      [10, 20, 30, 255],
      [30, 20, 10, 255],
    ]);
  });

  it('decode 抛异常 → 返回空串，不抛（且不再试第二条通道）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn, calls } = spyDecode(() => {
      throw new Error('decoder exploded');
    });
    const qr = createQr({ loadImage: () => imageWithBitmap(bitmap(2, 2)), decode: fn });
    await expect(qr.recognize('x.png')).resolves.toBe('');
    expect(calls.length).toBe(1);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('[qr] ');
  });
});

describe('位图长度不足（绝不越界读）', () => {
  it('10×10 只给 100 字节 → 不抛，返回空串', async () => {
    const { fn } = spyDecode(() => null);
    const qr = createQr({
      loadImage: () => imageWithBitmap(Buffer.alloc(100), { width: 10, height: 10 }),
      decode: fn,
    });
    await expect(qr.recognize('short.png')).resolves.toBe('');
  });

  it('10×10 只给 100 字节 → 裁成 10×2 再交给 decode（宽不变，只裁高度）', async () => {
    const { fn, calls } = spyDecode(() => null);
    const qr = createQr({
      loadImage: () => imageWithBitmap(Buffer.alloc(100), { width: 10, height: 10 }),
      decode: fn,
    });
    await qr.recognize('short.png');
    expect(calls.map((c) => c.width)).toEqual([10, 10]);
    expect(calls.map((c) => c.height)).toEqual([2, 2]);
    // 每条通道拿到的字节都必须是 10*2*4 = 80，正好是裁剪后的 span。
    expect(calls.map((c) => c.data.length)).toEqual([80, 80]);
  });

  it('字节数连一行都凑不齐 → 退化成「可用像素 = 宽、高 1」', async () => {
    const { fn, calls } = spyDecode(() => null);
    const qr = createQr({
      loadImage: () => imageWithBitmap(Buffer.alloc(12), { width: 10, height: 10 }),
      decode: fn,
    });
    await qr.recognize('short.png');
    // 12 字节 = 3 像素 → 宽 3、高 1。
    expect(calls.map((c) => c.width)).toEqual([3, 3]);
    expect(calls.map((c) => c.height)).toEqual([1, 1]);
    expect(calls.map((c) => c.data.length)).toEqual([12, 12]);
  });
});

describe('bgraToRgba', () => {
  it('把 [B,G,R,A] 换成 [R,G,B,A]', () => {
    expect(Array.from(bgraToRgba(Buffer.from([1, 2, 3, 4])))).toEqual([3, 2, 1, 4]);
  });

  it('多像素逐个换序，G/A 原位不动', () => {
    const out = bgraToRgba(Buffer.from([0, 128, 255, 7, 255, 128, 0, 9]));
    expect(Array.from(out)).toEqual([255, 128, 0, 7, 0, 128, 255, 9]);
  });

  it('长度不是 4 的整数倍时补齐 0，不越界', () => {
    const out = bgraToRgba(Buffer.from([10, 20, 30, 40, 50]));
    expect(out.length).toBe(5);
    expect(Array.from(out.slice(0, 4))).toEqual([30, 20, 10, 40]);
    expect(out[4]).toBe(0);
  });

  it('返回的是 Uint8ClampedArray', () => {
    expect(bgraToRgba(Buffer.alloc(4))).toBeInstanceOf(Uint8ClampedArray);
  });
});

describe('fitBitmap', () => {
  it('字节够 → 原样返回', () => {
    expect(fitBitmap(2, 2, 16)).toEqual({ width: 2, height: 2 });
  });

  it('宽或高为 0 → null', () => {
    expect(fitBitmap(0, 5, 100)).toBeNull();
    expect(fitBitmap(5, 0, 100)).toBeNull();
  });

  it('一个像素都不够 → null', () => {
    expect(fitBitmap(5, 5, 3)).toBeNull();
  });

  it('非有限数按 0 处理 → null', () => {
    expect(fitBitmap(Number.NaN, 5, 100)).toBeNull();
  });

  it('小数尺寸向下取整', () => {
    expect(fitBitmap(2.9, 2.9, 16)).toEqual({ width: 2, height: 2 });
  });
});

describe('默认解码器（真 jsqr）', () => {
  it('纯色小图没有二维码 → 返回空串，不抛', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qr = createQr({ loadImage: () => imageWithBitmap(Buffer.alloc(8 * 8 * 4, 0), { width: 8, height: 8 }) });
    await expect(qr.recognize('blank.png')).resolves.toBe('');
  });
});
