/**
 * images.ts 像素判定函数的用例（T-M10：一次复制只解码一次像素）。
 *
 * ★ 全程不依赖 Electron：假图用真实的 BGRA Buffer 冒充 toBitmap() 的产物，
 *   并在每次调用时回调计数 —— "解码收敛成一个出口"这件事本身靠它钉住。
 */
import { describe, expect, it } from 'vitest';
import {
  detectAlpha,
  detectAlphaFrom,
  imagePhash,
  phashFrom,
  pixelsOf,
  type NativeImageLike,
} from './images';

/**
 * 带 toBitmap 的假图：位图是真实的 BGRA Buffer（w*h*4 字节，横向渐变保证 dHash 不为全 0），
 * toBitmap 每被调一次先回调 onBitmap —— 数"解码了几次"全靠它。
 */
function fakeImageWithBitmap(w: number, h: number, onBitmap?: () => void): NativeImageLike {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round((x / Math.max(1, w - 1)) * 255);
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return {
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: (o) => fakeImageWithBitmap(o.width ?? w, o.height ?? h, onBitmap),
    toPNG: () => Buffer.from(buf),
    toJPEG: () => Buffer.from(buf),
    toBitmap: () => {
      onBitmap?.();
      return Buffer.from(buf);
    },
  };
}

describe('★ 一次复制只解码一次像素（T-M10）', () => {
  it('pixelsOf 每个 img 只调一次 toBitmap，两个下游判定不再碰图', () => {
    let calls = 0;
    const img = fakeImageWithBitmap(64, 64, () => {
      calls += 1;
    });
    const bmp = pixelsOf(img);
    expect(bmp).not.toBeNull();
    detectAlphaFrom(bmp!);
    phashFrom(bmp!, img.getSize());
    expect(calls).toBe(1);
  });

  it('alpha 判定与 phash 的结果必须与原实现一致（合并只改代价，不改行为）', () => {
    const img = fakeImageWithBitmap(32, 32, () => {});
    expect(detectAlphaFrom(pixelsOf(img)!)).toBe(detectAlpha(img));
    expect(phashFrom(pixelsOf(img)!, img.getSize())).toBe(imagePhash(img));
  });

  it('没有 toBitmap 时回 null，两个下游都安静降级（不抛）', () => {
    const img = { toPNG: () => Buffer.from(''), isEmpty: () => false } as unknown as NativeImageLike;
    expect(pixelsOf(img)).toBeNull();
    expect(detectAlphaFrom(null)).toBe(false);
    expect(phashFrom(null)).toBeUndefined();
  });
});
