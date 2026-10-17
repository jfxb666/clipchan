#!/usr/bin/env node
// 从 1024x1024 源图生成 assets/icon.png、build/icon.png 与 build/icon.ico（7 帧）。
// 只依赖 Node 内置 zlib，不引任何图形库（本机没有 sharp / ImageMagick）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-10-15-clipchan-icon-source.png');

/** 解 PNG，只支持 bitDepth=8 的 colorType 2（RGB）与 6（RGBA），显式拒绝隔行。 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG 文件（签名不匹配）');
  }
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 bitDepth=8，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行 PNG（interlace=' + interlace + '）');
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (channels === 0) throw new Error('不支持的 colorType=' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff; break;
        }
        default: throw new Error('未知 PNG filter ' + filter);
      }
      cur[x] = v;
    }
  }

  // 统一成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (colorType === 3) {
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      a = trns && idx < trns.length ? trns[idx] : 255;
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, data: rgba };
}

/** 盒式降采样（面积平均），支持任意目标尺寸。 */
export function resizeRgba(img, w, h) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(w * h * 4);
  const xr = sw / w, yr = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * yr)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * xr)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** 编码 RGBA 为 PNG（filter 0，colorType 6）。 */
export function encodePng(img) {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 组装 ICO：目录项 + 内嵌 PNG（Vista+ 支持）。帧顺序从大到小。 */
export function buildIco(frames) {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  frames.forEach((f, i) => {
    const png = encodePng(f.img);
    const b = i * 16;
    dir[b] = f.size >= 256 ? 0 : f.size;
    dir[b + 1] = f.size >= 256 ? 0 : f.size;
    dir[b + 2] = 0; dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

export function main() {
  if (!fs.existsSync(SOURCE)) throw new Error('找不到源图：' + SOURCE);
  const src = decodePng(fs.readFileSync(SOURCE));
  if (src.width !== 1024 || src.height !== 1024) {
    console.warn('[icons] 源图不是 1024x1024，实际 ' + src.width + 'x' + src.height);
  }
  const assetsDir = path.join(ROOT, 'assets');
  const buildDir = path.join(ROOT, 'build');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const sourceCopy = fs.readFileSync(SOURCE);
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), sourceCopy);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), sourceCopy);

  const frames = ICO_SIZES.map((size) => ({ size, img: resizeRgba(src, size, size) }));
  const ico = buildIco(frames);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

  console.log('[icons] 源图 ' + src.width + 'x' + src.height + ' → assets/icon.png (' + sourceCopy.length + ' B)');
  console.log('[icons] build/icon.ico ' + ico.length + ' B，' + ICO_SIZES.length + ' 帧：' + ICO_SIZES.join('/'));
  return { frames: ICO_SIZES.length, bytes: ico.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error('[icons] 失败：' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}
