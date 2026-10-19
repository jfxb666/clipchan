/**
 * zip 导出 / 导入的行为测试（v0.3.0 §3 T4）。
 *
 * ★ 全部走真盘：临时目录 + 真写 zip + 真读回来。mock 掉 fs 的测试只能证明代码被调用过，
 *   证明不了「换个目录还认得回来」这件事 —— 而备份包的价值恰恰在跨目录/跨机器。
 * ★ dialog 用注入的 pickSave / pickOpen 替代：本文件不 import electron（见 export-import.ts 头注释）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import { hashBuffer, openDb } from './db';
import type { Db } from './db';
import { imageAbs } from './paths';
import {
  EXPORT_VERSION,
  MANIFEST_NAME,
  exportAllToZip,
  exportFileName,
  importAllFromZip,
  importSummaryText,
} from './export-import';
import type { ExportManifest } from './export-import';

const opened: Db[] = [];
const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-exp-'));
  tmpDirs.push(d);
  return d;
}

/** 一个「数据目录 + 库」的组合，模拟一台机器。 */
function machine(): { dir: string; db: Db } {
  const dir = tmpDir();
  const db = openDb(join(dir, 'clipchan.db'));
  opened.push(db);
  return { dir, db };
}

/** 往盘上写一个假图片文件（内容是任意字节，导出只搬运不做解码）。 */
function putFile(dir: string, rel: string, bytes: Buffer): void {
  const abs = imageAbs(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** 造一台「有 1 条文本 + 1 条图片（含缩略图）」的机器。 */
function seed(m: { dir: string; db: Db }): { textId: string; imageId: string } {
  const t = m.db.insertText('一段会被备份的文本', { createdAt: 1_700_000_000_000, seq: 1 });
  // 哈希按真实字节算：导入端也按真实字节重算，两边一致才谈得上「内容重复」。
  const img = m.db.insertImage(
    {
      hash: hashBuffer(Buffer.from([1, 2, 3, 4, 5])),
      width: 4,
      height: 3,
      bytes: 5,
      imagePath: 'images/a.jpg',
      thumbPath: 'thumbs/a.png',
      createdAt: 1_700_000_001_000,
      seq: 2,
    },
    {},
  );
  putFile(m.dir, 'images/a.jpg', Buffer.from([1, 2, 3, 4, 5]));
  putFile(m.dir, 'thumbs/a.png', Buffer.from([9, 9]));
  return { textId: t.id, imageId: img.id };
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('导出为 zip 备份包', () => {
  it('用户取消保存对话框 → {cancelled:true}，不抛也不写文件', async () => {
    const m = machine();
    seed(m);
    const r = await exportAllToZip({
      db: m.db,
      dataDir: m.dir,
      pickSave: async () => ({ canceled: true }),
    });
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    // 取消不是错误：不该有 reason（界面据此静默，不弹「导出失败」）
    expect(r.reason).toBeUndefined();
  });

  it('包内结构：manifest.json + images/ + thumbs/，且不含回收站内容', async () => {
    const m = machine();
    const { textId, imageId } = seed(m);
    // 一条进回收站的记录：导出是「我的有效历史」，它不该出现在包里。
    const trashed = m.db.insertText('已经删掉的内容', { createdAt: 1_700_000_002_000, seq: 3 });
    m.db.remove(trashed.id);

    const out = join(tmpDir(), 'backup.zip');
    const r = await exportAllToZip({ db: m.db, dataDir: m.dir, pickSave: async () => ({ canceled: false, filePath: out }) });
    expect(r.ok).toBe(true);
    expect(r.items).toBe(2);
    expect(r.missingImages).toBe(0);

    const zip = new AdmZip(out);
    const names = zip.getEntries().map((x) => x.entryName).sort();
    expect(names).toContain(MANIFEST_NAME);
    expect(names.some((n) => n.startsWith('images/'))).toBe(true);
    expect(names.some((n) => n.startsWith('thumbs/'))).toBe(true);

    const manifest = JSON.parse(zip.readAsText(MANIFEST_NAME)) as ExportManifest;
    expect(manifest.app).toBe('Clipchan');
    expect(manifest.version).toBe(EXPORT_VERSION);
    expect(manifest.items).toHaveLength(2);
    expect(manifest.items.map((i) => i.id).sort()).toEqual([textId, imageId].sort());
    // 语义字段齐、且**没有** deletedAt
    const img = manifest.items.find((i) => i.id === imageId)!;
    expect(img.kind).toBe('image');
    expect(img.imageFile).toMatch(/^images\//);
    expect(img.width).toBe(4);
    expect(img.height).toBe(3);
    expect(img.seq).toBe(2);
    expect(img).not.toHaveProperty('deletedAt');
    // 原图字节原样在包里
    const entry = zip.getEntry(img.imageFile!)!;
    expect([...zip.readFile(entry)!]).toEqual([1, 2, 3, 4, 5]);
  });

  it('原图文件缺失：该条仍导出，imageFile=null 且 missingImages 计数', async () => {
    const m = machine();
    // 直接造一行「有 image_path 但盘上没有文件」的记录
    m.db.raw
      .prepare(
        "INSERT INTO items (id, kind, content, image_path, image_hash, width, height, bytes, source, pinned, truncated, created_at, seq) " +
          "VALUES ('gone', 'image', NULL, 'images/gone.png', 'hash-gone', 10, 10, 100, 'clip', 0, 0, 1700000000000, 1)",
      )
      .run();
    m.db.insertText('文字还是能导出去的', { createdAt: 1_700_000_001_000, seq: 2 });

    const out = join(tmpDir(), 'missing.zip');
    const r = await exportAllToZip({ db: m.db, dataDir: m.dir, pickSave: async () => ({ canceled: false, filePath: out }) });
    expect(r.ok).toBe(true);
    expect(r.items).toBe(2);
    expect(r.missingImages).toBe(1);

    const manifest = JSON.parse(new AdmZip(out).readAsText(MANIFEST_NAME)) as ExportManifest;
    const gone = manifest.items.find((i) => i.id === 'gone')!;
    expect(gone.imageFile).toBeNull();
    expect(gone.content).toBeNull();
    // 缺图不该让整次导出失败：文本条照旧在
    expect(manifest.items.find((i) => i.kind === 'text')).toBeTruthy();
  });

  it('默认文件名带本地时间戳（一天导多次不会互相覆盖）', () => {
    expect(exportFileName(new Date(2026, 9, 19, 8, 5, 3))).toBe('clipchan-export-20261019-080503.zip');
  });
});

describe('导入 zip 备份包', () => {
  it('导出 → 导入到空库：条数与图片字节都回来', async () => {
    const a = machine();
    const { textId, imageId } = seed(a);
    const out = join(tmpDir(), 'roundtrip.zip');
    const exp = await exportAllToZip({ db: a.db, dataDir: a.dir, pickSave: async () => ({ canceled: false, filePath: out }) });
    expect(exp.ok).toBe(true);

    const b = machine();
    const r = await importAllFromZip({ db: b.db, dataDir: b.dir, pickOpen: async () => ({ canceled: false, filePaths: [out] }) });
    expect(r).toMatchObject({ ok: true, imported: 2, skippedDuplicate: 0, skippedInvalid: 0, missingImages: 0 });

    // id 原样回来（备份包不是「重新生成一份」，用户点开还是同一条）
    const text = b.db.getRow(textId)!;
    expect(text.content).toBe('一段会被备份的文本');
    expect(text.created_at).toBe(1_700_000_000_000);
    expect(text.seq).toBe(1);

    const img = b.db.getImageRow(imageId)!;
    expect(img.width).toBe(4);
    expect(img.height).toBe(3);
    expect(img.image_path).toMatch(/^images\//);
    // 真盘上真的有这张图，且字节一致
    const absImg = imageAbs(b.dir, img.image_path!);
    expect(existsSync(absImg)).toBe(true);
    expect([...readFileSync(absImg)]).toEqual([1, 2, 3, 4, 5]);
    expect(existsSync(imageAbs(b.dir, img.thumb_path!))).toBe(true);
  });

  it('重复 id / 重复内容哈希：跳过计数正确，且现有数据一条没少', async () => {
    const a = machine();
    seed(a);
    const before = a.db.count({});
    const out = join(tmpDir(), 'dup.zip');
    await exportAllToZip({ db: a.db, dataDir: a.dir, pickSave: async () => ({ canceled: false, filePath: out }) });

    // 导回自己：id 全撞上 → 全部跳过，绝不覆盖
    const r = await importAllFromZip({ db: a.db, dataDir: a.dir, pickOpen: async () => ({ canceled: false, filePaths: [out] }) });
    expect(r).toMatchObject({ ok: true, imported: 0, skippedDuplicate: 2, skippedInvalid: 0 });
    expect(a.db.count({})).toBe(before);

    // 换一批 id 但内容/图片字节相同 → 命中 contentHash / imageHash 去重
    const zip = new AdmZip(out);
    const manifest = JSON.parse(zip.readAsText(MANIFEST_NAME)) as ExportManifest;
    manifest.items = manifest.items.map((i) => ({ ...i, id: 'copy-' + i.id }));
    const forged = join(tmpDir(), 'dup2.zip');
    const rebuilt = new AdmZip();
    rebuilt.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest), 'utf8'));
    for (const i of manifest.items) {
      if (!i.imageFile) continue;
      rebuilt.addFile(i.imageFile, zip.readFile(zip.getEntry(i.imageFile)!)!);
    }
    rebuilt.writeZip(forged);

    const r2 = await importAllFromZip({ db: a.db, dataDir: a.dir, pickOpen: async () => ({ canceled: false, filePaths: [forged] }) });
    expect(r2).toMatchObject({ ok: true, imported: 0, skippedDuplicate: 2 });
    // 旧数据一条没少、也没被改名
    expect(a.db.count({})).toBe(before);
  });

  it('坏条目跳过并计数，好条目照进（不整体回滚）', async () => {
    const bad = join(tmpDir(), 'bad-items.zip');
    const zip = new AdmZip();
    zip.addFile(
      MANIFEST_NAME,
      Buffer.from(
        JSON.stringify({
          app: 'Clipchan',
          version: 2,
          exportedAt: new Date(0).toISOString(),
          items: [
            { id: 'ok-1', kind: 'text', content: '好的一条', createdAt: 1, seq: 1 },
            {}, // 没有 id
            { id: 'bad-kind', kind: 'video', content: 'x', createdAt: 1, seq: 2 },
            { id: 'bad-img', kind: 'image', imageFile: 'images/nope.png', createdAt: 1, seq: 3 },
            { id: 'bad-time', kind: 'text', content: 'y', seq: 4 },
          ],
        }),
        'utf8',
      ),
    );
    zip.writeZip(bad);

    const m = machine();
    const warnings: string[] = [];
    const r = await importAllFromZip({
      db: m.db,
      dataDir: m.dir,
      pickOpen: async () => ({ canceled: false, filePaths: [bad] }),
      onWarning: (w) => warnings.push(w),
    });
    expect(r.ok).toBe(true);
    expect(r.imported).toBe(1);
    expect(r.skippedInvalid).toBe(4);
    // 图片条目缺文件 → 同时算进 missingImages
    expect(r.missingImages).toBe(1);
    expect(warnings.length).toBe(4);
    expect(m.db.count({})).toBe(1);
  });

  it('manifest.json 缺失 / 不是合法 JSON / 没有 items：返回 reason 而不是抛', async () => {
    const m = machine();

    const noManifest = join(tmpDir(), 'no-manifest.zip');
    const z1 = new AdmZip();
    z1.addFile('readme.txt', Buffer.from('hi', 'utf8'));
    z1.writeZip(noManifest);
    const r1 = await importAllFromZip({ db: m.db, dataDir: m.dir, pickOpen: async () => ({ canceled: false, filePaths: [noManifest] }) });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain('manifest.json');

    const brokenJson = join(tmpDir(), 'broken.zip');
    const z2 = new AdmZip();
    z2.addFile(MANIFEST_NAME, Buffer.from('{ 这不是 JSON', 'utf8'));
    z2.writeZip(brokenJson);
    const r2 = await importAllFromZip({ db: m.db, dataDir: m.dir, pickOpen: async () => ({ canceled: false, filePaths: [brokenJson] }) });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('不是合法 JSON');

    const noItems = join(tmpDir(), 'no-items.zip');
    const z3 = new AdmZip();
    z3.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify({ app: 'Clipchan', version: 2 }), 'utf8'));
    z3.writeZip(noItems);
    const r3 = await importAllFromZip({ db: m.db, dataDir: m.dir, pickOpen: async () => ({ canceled: false, filePaths: [noItems] }) });
    expect(r3.ok).toBe(false);
    expect(r3.reason).toContain('items');

    // 三次坏包都没往库里塞东西
    expect(m.db.count({})).toBe(0);
  });

  it('用户取消打开对话框 → {cancelled:true}，不抛', async () => {
    const m = machine();
    const r = await importAllFromZip({ db: m.db, dataDir: m.dir, pickOpen: async () => ({ canceled: true, filePaths: [] }) });
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('对话框本身抛错时如实带出原因（不当成取消）', async () => {
    const m = machine();
    const r = await importAllFromZip({
      db: m.db,
      dataDir: m.dir,
      pickOpen: async () => {
        throw new Error('没有显示器');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBeUndefined();
    expect(r.reason).toContain('没有显示器');
  });

  it('汇总文案只列非零项（避免「跳过重复 0 条」这种噪音）', () => {
    expect(importSummaryText({ ok: true, imported: 12, skippedDuplicate: 0, skippedInvalid: 0, missingImages: 0 })).toBe('导入 12 条');
    expect(importSummaryText({ ok: true, imported: 12, skippedDuplicate: 3, skippedInvalid: 1, missingImages: 0 })).toBe(
      '导入 12 条，跳过重复 3 条，坏条 1 条',
    );
  });
});
