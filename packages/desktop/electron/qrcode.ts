/**
 * 二维码解码（jsqr）。
 *
 * ★ 铁律与 ocr.ts 完全一致：顶层**不 import electron、不 import fs**。
 *   读图（nativeImage.createFromPath）与像素转换只能从 QrDeps 注入 ——
 *   否则 qrcode.spec.ts 在没有 Electron 运行时的环境里根本 import 不进来。
 * ★ recognize 永不抛异常：识别失败一律回 ''（右键点错了不该弹错误框）。
 *
 * ★ 不做降采样（YAGNI）：jsqr 解 2560px 的图仍是毫秒级。
 *   若日后卡顿，先 resize 到 1024 再解（images.ts 的 MAX_IMAGE_EDGE 就是 2560）。
 */
import jsQR from 'jsqr';

/** 主进程注入的图片能力（只用到这两个方法）。 */
export interface QrImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  /** BGRA 或 RGBA 位图；由注入方保证长度 = width*height*4。 */
  toBitmap?(): Buffer;
}

export interface QrDeps {
  /** 从磁盘读图，返回可查询像素的图片对象；读不出时返回 null。 */
  loadImage: (imagePath: string) => QrImageLike | null;
  /** 把图片缩放/转码成 PNG 字节（可选预处理，缺省不做）。 */
  prepare?: (imagePath: string) => { data: Uint8Array } | null;
  /** 解码器注入，缺省用 jsqr。 */
  decode?: (rgba: Uint8Array, width: number, height: number) => string | null;
}

export interface QrApi {
  /** 识别一张图片里的二维码；未识别到返回 ''。永不抛异常。 */
  recognize(imagePath: string): Promise<string>;
}

/** 日志前缀，与 ocr.ts / images.ts 的 '[ocr] ' '[images] ' 保持一致。 */
const WARN = '[qr] ';

/** jsQR 结果里我们只读 data —— 自己声明最小形状，不依赖它 .d.ts 的其余字段。 */
export interface JsQrResultLike {
  data: string;
}

/** 失败原因统一成一句可读文本；非 Error 也要有字（绝不回 undefined 假装成功）。 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && e.message !== '') return e.message;
  return String(e);
}

/**
 * BGRA → RGBA（交换每像素的 B 与 R，G/A 原位不动）。
 *
 * ★ 这是本模块最容易踩的坑：Electron 的 `nativeImage.toBitmap()` 给的是 **BGRA**，
 *   而 jsqr 要 **RGBA**。不换序的后果是「本地用 PNG 测好了，打包装完就再也识别不出」——
 *   因为红蓝对调后二维码的黑白块对比度被打乱，定位图案直接失效，jsqr 只会安静地返回 null。
 *
 * @param buf BGRA 字节；长度不是 4 的整数倍时，尾部残像素按 0 补齐（不越界）。
 */
export function bgraToRgba(buf: Buffer): Uint8ClampedArray {
  const out = new Uint8ClampedArray(buf.length);
  for (let i = 0; i < buf.length; i += 4) {
    // ★ 逐通道 ?? 0：noUncheckedIndexedAccess 下下标读取是 number | undefined，
    //   而尾部残像素（长度非 4 倍数）本来就可能缺字节。
    out[i] = buf[i + 2] ?? 0;
    out[i + 1] = buf[i + 1] ?? 0;
    out[i + 2] = buf[i] ?? 0;
    out[i + 3] = buf[i + 3] ?? 0;
  }
  return out;
}

/**
 * 位图长度校验：算出一个**真正读得到**的矩形，绝不让 jsqr 越界读。
 *
 * ★ 长度不够时只裁高度（stride 不变，可以零拷贝取前 N 个字节）；
 *   连一整行都凑不齐才退化成 1 行、宽度按可用像素数。
 *
 * @param width 声明的宽（px）
 * @param height 声明的高（px）
 * @param byteLength 实际拿到的字节数
 * @returns 可用的矩形；宽或高为 0、或一个像素都凑不齐时返回 null。
 */
export function fitBitmap(
  width: number,
  height: number,
  byteLength: number,
): { width: number; height: number } | null {
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  const h = Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;
  if (w === 0 || h === 0) return null;
  const pixels = Number.isFinite(byteLength) && byteLength > 0 ? Math.floor(byteLength / 4) : 0;
  if (pixels === 0) return null;
  if (pixels >= w * h) return { width: w, height: h };
  const rows = Math.floor(pixels / w);
  if (rows >= 1) return { width: w, height: rows };
  return { width: pixels, height: 1 };
}

/**
 * 把注入层给的字节统一成 Buffer 视图。
 * ★ 不用 Buffer.from(bytes)：那会复制一份，2560×1440 的位图就是 14MB。
 */
function toBuffer(bytes: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
}

/**
 * 默认解码器：jsqr。
 * ★ jsqr 要 Uint8ClampedArray，而 QrDeps.decode 的签名是 Uint8Array，
 *   所以两边都用「同一块内存的零拷贝视图」互转，不做复制。
 */
function defaultDecode(rgba: Uint8Array, width: number, height: number): string | null {
  const view = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
  const found: JsQrResultLike | null = jsQR(view, width, height);
  return found ? found.data : null;
}

/**
 * 造二维码识别面。
 * @param deps 依赖注入；main.ts 传 { loadImage, prepare }。
 */
export function createQr(deps: QrDeps): QrApi {
  const { prepare } = deps;
  const decode = deps.decode ?? defaultDecode;

  /** 一次解码尝试；fatal=true 表示 decode 自己抛了 —— 换通道顺序也救不回来。 */
  const safeDecode = (
    data: Uint8Array,
    width: number,
    height: number,
  ): { text: string; fatal: boolean } => {
    try {
      const out = decode(data, width, height);
      // null / 非字符串 / '' 一律算「这次没解出」，继续试下一条通道。
      return { text: typeof out === 'string' ? out : '', fatal: false };
    } catch (e) {
      console.warn(WARN + '解码失败：' + reasonOf(e));
      return { text: '', fatal: true };
    }
  };

  /**
   * 同一个像素来源的两条通道：先 RGBA 直喂，再 BGRA 换序。
   * ★ 两条都试是刻意的：toBitmap 的通道顺序取决于平台与图片格式，
   *   而注入实现（测试替身、PNG 解出来的像素）多数本来就是 RGBA。两条都试对谁都不亏。
   */
  const trySource = (
    bytes: Buffer,
    width: number,
    height: number,
  ): { text: string; fatal: boolean } => {
    const span = width * height * 4;
    const direct = safeDecode(new Uint8Array(bytes.buffer, bytes.byteOffset, span), width, height);
    if (direct.fatal || direct.text !== '') return direct;
    // ★ 换序结果是对齐 jsqr 的 Uint8ClampedArray，而 QrDeps.decode 的签名是 Uint8Array
    //   （任务书钉死的形状）。两者只是同一块内存的两种视图，转一次仍是零拷贝。
    const swapped = bgraToRgba(bytes.subarray(0, span));
    return safeDecode(new Uint8Array(swapped.buffer, swapped.byteOffset, swapped.length), width, height);
  };

  return {
    recognize: async (imagePath: string): Promise<string> => {
      try {
        const img = deps.loadImage(imagePath);
        if (!img || img.isEmpty()) return '';
        const size = img.getSize();
        // ★ floor 而不是 round：宁可少认一列像素，也不能让下面的 span 超出真实字节数。
        const width = Math.floor(size.width);
        const height = Math.floor(size.height);
        if (!(width > 0) || !(height > 0)) return '';

        // 像素来源：prepare 优先，toBitmap 兜底（两者都拿不到就返回 ''）。
        const sources: Buffer[] = [];
        if (prepare) {
          try {
            const p = prepare(imagePath);
            if (p && p.data !== undefined && p.data.length > 0) sources.push(toBuffer(p.data));
          } catch (e) {
            // ★ 预处理只是提质手段，失败不能拖垮识别：退回 toBitmap 通道。
            console.warn(WARN + '预处理失败，退回位图通道：' + reasonOf(e));
          }
        }
        if (typeof img.toBitmap === 'function') {
          try {
            const bmp = img.toBitmap();
            if (bmp !== undefined && bmp.length > 0) sources.push(toBuffer(bmp));
          } catch (e) {
            console.warn(WARN + '取位图失败：' + reasonOf(e));
          }
        }
        if (sources.length === 0) {
          console.warn(WARN + '取不到可用像素：' + imagePath);
          return '';
        }

        for (const bytes of sources) {
          const fit = fitBitmap(width, height, bytes.length);
          if (!fit) continue;
          const res = trySource(bytes, fit.width, fit.height);
          if (res.text !== '') return res.text;
          if (res.fatal) return '';
        }
        return '';
      } catch (e) {
        // ★ 最后一道网：loadImage / getSize 抛了也只回 ''，绝不把异常丢给 IPC 层。
        console.warn(WARN + '识别失败（已忽略）：' + reasonOf(e));
        return '';
      }
    },
  };
}
