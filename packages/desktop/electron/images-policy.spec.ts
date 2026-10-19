import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planBudgetEviction, sweepOrphans } from './images-policy';
import { purgeItemsWithFiles, saveImage } from './images';
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

describe('Review Focus 4：图片文件生命周期（v0.3.0 软删 vs 硬删）', () => {
  /** 落一张真图并建行，返回库行 id 与两个文件的绝对路径。 */
  function seedImage(db: ReturnType<typeof openDb>, dir: string, id: string) {
    const saved = saveImage(dir, id, makeFake(800, 600, false));
    const r = db.insertImage({
      hash: 'h-' + id,
      width: saved.width,
      height: saved.height,
      bytes: saved.bytes,
      imagePath: saved.image_path,
      thumbPath: saved.thumb_path,
    });
    return {
      rowId: r.id,
      image: join(dir, 'images', id + '.jpg'),
      thumb: join(dir, 'thumbs', id + '.png'),
    };
  }

  it('★ 软删（remove）后记录进回收站，但原图与缩略图**仍在盘上**', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    const s = seedImage(db, dir, 'soft');
    expect(existsSync(s.image)).toBe(true);
    expect(existsSync(s.thumb)).toBe(true);

    // 软删 = 只盖 deleted_at。走 db.remove（main.ts 的 items:remove 就是这么做的）。
    const row = db.remove(s.rowId);
    expect(row).not.toBeNull();

    // 活跃列表里没有了、回收站里有
    expect(db.list({ limit: 50 }).some((r) => r.id === s.rowId)).toBe(false);
    expect(db.listTrash({}).some((r) => r.id === s.rowId)).toBe(true);
    // ★ 回收站的全部意义：文件一个都没删
    expect(existsSync(s.image)).toBe(true);
    expect(existsSync(s.thumb)).toBe(true);
    db.close();
  });

  it('★ purge 后记录与两个文件都消失（唯一删盘入口）', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    const s = seedImage(db, dir, 'purge');

    const out = purgeItemsWithFiles(db, dir, [s.rowId]);
    expect(out.removed).toBe(1);
    expect(out.log.failures).toEqual([]);
    expect(db.getRow(s.rowId)).toBeNull();
    expect(existsSync(s.image)).toBe(false);
    expect(existsSync(s.thumb)).toBe(false);
    db.close();
  });

  it('回收站里的行被 purge 时文件同样消失', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    const s = seedImage(db, dir, 'trashed');
    db.remove(s.rowId); // 先进回收站
    expect(existsSync(s.image)).toBe(true);

    const out = purgeItemsWithFiles(db, dir, [s.rowId]);
    expect(out.removed).toBe(1);
    expect(existsSync(s.image)).toBe(false);
    expect(existsSync(s.thumb)).toBe(false);
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

  it('★ 回收站行的文件不会被 sweepOrphans 当成孤儿删掉', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    const s = seedImage(db, dir, 'kept');
    db.remove(s.rowId); // 进回收站，行还在库里

    // allImageRows 含回收站行（db 侧刻意不过滤），所以孤儿扫描认得这两个文件
    const removed = sweepOrphans(dir, db.allImageRows());
    expect(removed).toEqual([]);
    expect(existsSync(s.image)).toBe(true);
    expect(existsSync(s.thumb)).toBe(true);
    db.close();
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
    const out = purgeItemsWithFiles(db, dir, [r.id], (m: string) => logs.push(m));
    // 数据库删除已提交（不回滚）
    expect(out.removed).toBe(1);
    expect(db.getRow(r.id)).toBeNull();
    // 文件删除失败被记录，但没有抛出
    expect(out.log.failures.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    db.close();
  });
});

describe('planBudgetEviction：回收站行优先腾', () => {
  it('回收站行排在活跃行前面，即使它更新', () => {
    const rows = [
      { id: 'old-active', pinned: false, bytes: 100, created_at: 1 },
      { id: 'new-trashed', pinned: false, bytes: 100, created_at: 9, deletedAt: 50 },
    ];
    // 总量 200、预算 100 → 目标 80，删一条就够（-100 → 100 > 80，要删两条）
    const evicted = planBudgetEviction(rows, 100);
    expect(evicted[0]).toBe('new-trashed');
  });

  it('回收站行也计入总量（文件还在盘上，不能假装不占额度）', () => {
    const rows = [
      { id: 'a', pinned: false, bytes: 100, created_at: 1, deletedAt: 5 },
      { id: 'b', pinned: false, bytes: 100, created_at: 2 },
    ];
    // 若回收站行不计入总量（100）→ 已达标、返回空；计入（200）→ 必须淘汰
    expect(planBudgetEviction(rows, 100).length).toBeGreaterThan(0);
  });
});
