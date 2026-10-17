import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planBudgetEviction, sweepOrphans } from './images-policy';
import { removeItemsWithFiles, saveImage } from './images';
import type { NativeImageLike } from './images';
import { openDb } from './db';

const MB = 1024 * 1024;
const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-img-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个记录调用的假 NativeImage，避免依赖 electron。 */
function makeFake(w0: number, h0: number, alpha: boolean, calls: string[] = []): NativeImageLike {
  return {
    getSize: () => ({ width: w0, height: h0 }),
    isEmpty: () => false,
    hasAlpha: () => alpha,
    toPNG: () => {
      calls.push('toPNG');
      return Buffer.from('PNG:' + w0 + 'x' + h0);
    },
    toJPEG: (q: number) => {
      calls.push('toJPEG:' + q);
      return Buffer.from('JPEG:' + w0 + 'x' + h0);
    },
    resize: (o: { width?: number; height?: number }) => {
      calls.push('resize:' + (o.width ?? w0) + 'x' + (o.height ?? h0));
      return makeFake(o.width ?? w0, o.height ?? h0, alpha, calls);
    },
  };
}

describe('planBudgetEviction', () => {
  it('从最旧未收藏删到预算 80% 以下，收藏永不出现', () => {
    const rows = [
      { id: 'pin1', pinned: true, bytes: 60 * MB, created_at: 1 },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: 'p' + (i + 1),
        pinned: false,
        bytes: 60 * MB,
        created_at: i + 2,
      })),
    ];
    // 600MB 总量、512MB 预算 → 目标 409.6MB，删 4 张（360MB）才达标
    const evicted = planBudgetEviction(rows, 512 * MB);
    expect(evicted).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(evicted).not.toContain('pin1');
  });

  it('未超预算时返回空数组', () => {
    const rows = [{ id: 'a', pinned: false, bytes: 10 * MB, created_at: 1 }];
    expect(planBudgetEviction(rows, 512 * MB)).toEqual([]);
  });

  it('即使未达目标也不删收藏，只删未收藏', () => {
    const rows = [
      { id: 'pin1', pinned: true, bytes: 600 * MB, created_at: 1 },
      { id: 'u1', pinned: false, bytes: 10 * MB, created_at: 2 },
    ];
    expect(planBudgetEviction(rows, 512 * MB)).toEqual(['u1']);
  });
});

describe('sweepOrphans', () => {
  it('只返回磁盘有文件但库里无行的孤儿', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'images'), { recursive: true });
    mkdirSync(join(dir, 'thumbs'), { recursive: true });
    writeFileSync(join(dir, 'images', 'x.jpg'), 'x');
    writeFileSync(join(dir, 'thumbs', 'x.png'), 't');
    writeFileSync(join(dir, 'images', 'orphan.jpg'), 'o');
    const rows = [{ id: 'x', image_path: 'images/x.jpg', thumb_path: 'thumbs/x.png' }];
    expect(sweepOrphans(dir, rows)).toEqual([join(dir, 'images', 'orphan.jpg')]);
  });

  it('全部被引用时返回空数组', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'images'), { recursive: true });
    mkdirSync(join(dir, 'thumbs'), { recursive: true });
    writeFileSync(join(dir, 'images', 'x.png'), 'x');
    writeFileSync(join(dir, 'thumbs', 'x.png'), 't');
    const rows = [{ id: 'x', image_path: 'images/x.png', thumb_path: 'thumbs/x.png' }];
    expect(sweepOrphans(dir, rows)).toEqual([]);
  });
});

describe('saveImage', () => {
  it('无 alpha 走 toJPEG(80)，文件名 images/<id>.jpg 与 thumbs/<id>.png', () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const r = saveImage(dir, 'id1', makeFake(800, 600, false, calls));
    expect(r.image_path).toBe('images/id1.jpg');
    expect(r.thumb_path).toBe('thumbs/id1.png');
    expect(r.hasAlpha).toBe(false);
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    expect(r.bytes).toBeGreaterThan(0);
    expect(calls).toContain('toJPEG:80');
    expect(existsSync(join(dir, 'images', 'id1.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'thumbs', 'id1.png'))).toBe(true);
  });

  it('有 alpha 走 toPNG()，扩展名为 .png', () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const r = saveImage(dir, 'id2', makeFake(640, 480, true, calls));
    expect(r.hasAlpha).toBe(true);
    expect(r.image_path).toBe('images/id2.png');
    expect(calls).toContain('toPNG');
    expect(existsSync(join(dir, 'images', 'id2.png'))).toBe(true);
  });

  it('长边超 2560 先 resize 到 2560，缩略图长边 128', () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const r = saveImage(dir, 'big', makeFake(3000, 1800, false, calls));
    expect(calls).toContain('resize:2560x1536');
    expect(calls).toContain('resize:128x77');
    expect(r.width).toBe(2560);
    expect(r.height).toBe(1536);
  });

  it('缩略图按长边 128 等比缩放', () => {
    const dir = tmpDir();
    const calls: string[] = [];
    saveImage(dir, 'id3', makeFake(800, 600, false, calls));
    expect(calls).toContain('resize:128x96');
  });
});

describe('Review Focus 4：图片文件生命周期', () => {
  it('删除图片记录后 images/<id>.* 与 thumbs/<id>.png 都消失', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    const saved = saveImage(dir, 'keep', makeFake(800, 600, false));
    const r = db.insertImage({
      hash: 'h-keep',
      width: saved.width,
      height: saved.height,
      bytes: saved.bytes,
      imagePath: saved.image_path,
      thumbPath: saved.thumb_path,
    });
    expect(existsSync(join(dir, 'images', 'keep.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'thumbs', 'keep.png'))).toBe(true);

    const out = removeItemsWithFiles(db, dir, [r.id]);
    expect(out.removed).toBe(1);
    expect(db.getRow(r.id)).toBeNull();
    expect(existsSync(join(dir, 'images', 'keep.jpg'))).toBe(false);
    expect(existsSync(join(dir, 'thumbs', 'keep.png'))).toBe(false);
    db.close();
  });

  it('sweepOrphans 之后孤儿文件真的从磁盘消失', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'thumbs'), { recursive: true });
    writeFileSync(join(dir, 'thumbs', 'orphan.png'), 'o');
    const out = sweepOrphans(dir, []);
    expect(out).toContain(join(dir, 'thumbs', 'orphan.png'));
    expect(existsSync(join(dir, 'thumbs', 'orphan.png'))).toBe(false);
  });

  it('文件删除失败时数据库删除仍提交（不回滚），且日志里有记录', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    // 用目录冒充图片文件：Windows 上 unlinkSync 对目录抛 EPERM（不是 ENOENT），
    // 正好构造"文件删不掉"的场景。
    mkdirSync(join(dir, 'images', 'locked.png'), { recursive: true });
    const r = db.insertImage({
      hash: 'h-lock',
      width: 10,
      height: 10,
      bytes: 10,
      imagePath: 'images/locked.png',
      thumbPath: '',
    });
    const logs: string[] = [];
    const out = removeItemsWithFiles(db, dir, [r.id], (m) => logs.push(m));
    // 数据库删除已提交（不回滚）
    expect(out.removed).toBe(1);
    expect(db.getRow(r.id)).toBeNull();
    // 文件删除失败被记录，但没有抛出
    expect(out.log.failures.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    db.close();
  });
});
