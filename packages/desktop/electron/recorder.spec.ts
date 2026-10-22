/**
 * 记录管线测试（计划 Task 5 的 Step 5–8）。
 *
 * 用 `:memory:` 数据库 + 临时数据目录 + 假剪贴板 / 假 nativeImage，
 * 覆盖：启动基线不补录、文本分类与 10 万字符截断、图片落盘落库与文件生命周期、
 * historyLimit 淘汰（收藏不删）、图片预算淘汰（收藏不删）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { Recorder, normalizeSourceApp } from './recorder';
import { ClipboardWatcher, RICH_HTML_MAX, type ClipboardLike } from './watcher';
import { purgeItemsWithFiles, type NativeImageLike } from './images';
import { imagesDir, thumbsDir } from './paths';

let db: Db;
let dataDir: string;
const logs: string[] = [];

beforeEach(() => {
  db = openDb(':memory:');
  dataDir = mkdtempSync(join(tmpdir(), 'clipchan-recorder-'));
  logs.length = 0;
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 假图片（窄接口）：toPNG/toJPEG 返回固定长度、固定填充的 Buffer，方便算预算与哈希。 */
function fakeImage(w: number, h: number, fill = 7, bytes = 16): NativeImageLike {
  const buf = Buffer.alloc(bytes, fill);
  return {
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: (o) => fakeImage(o.width ?? w, o.height ?? h, fill, bytes),
    toPNG: () => Buffer.from(buf),
    toJPEG: () => Buffer.from(buf),
    hasAlpha: false,
  };
}

interface FakeClip extends ClipboardLike {
  state: { formats: string[]; text: string };
}

/** 假剪贴板：内容可以随时改，模拟用户换剪贴板。 */
function makeClip(text = '', formats: string[] = ['text/plain']): FakeClip {
  const state = { formats, text };
  return {
    state,
    availableFormats: () => state.formats,
    has: () => false,
    readText: () => state.text,
    readImage: () => fakeImage(10, 10),
  };
}

function makeRecorder(clip: FakeClip = makeClip(), now?: () => number): Recorder {
  return new Recorder({
    db,
    clip,
    dataDir,
    settings: () => db.getSettings(),
    now,
    onLog: (m) => logs.push(m),
  });
}

describe('Recorder.baseline 启动基线（验收 27）', () => {
  it('启动前就躺在剪贴板里的内容不补录，之后新复制的内容正常记录', async () => {
    const clip = makeClip('启动前就躺着的');
    const rec = makeRecorder(clip);

    rec.baseline();
    expect(db.list({}).length).toBe(0); // 基线只记 lastSeen，不写库

    const w = new ClipboardWatcher({
      clip,
      recorder: rec,
      intervalMs: 5,
      onTrace: () => {},
    });
    w.start();
    await sleep(40);
    expect(db.list({}).length).toBe(0); // 同内容连续多跳都不记
    expect(rec.lastSeen.text).toBe('启动前就躺着的');

    clip.state.text = '新复制的内容';
    await sleep(40);
    w.stop();

    const rows = db.list({});
    expect(rows.length).toBe(1);
    expect(rows[0]!.preview).toContain('新复制的内容');
  });

  it('剪贴板读不到时按"未知"处理（不假装已知道），后续内容仍会记录', () => {
    const clip = makeClip('旧内容');
    clip.availableFormats = () => {
      throw new Error('剪贴板被占用');
    };
    const rec = makeRecorder(clip);
    rec.baseline();
    expect(rec.lastSeen.text).toBeNull();
    expect(logs.some((m) => m.includes('建立启动基线失败'))).toBe(true);
  });
});

describe('Recorder.recordText', () => {
  it('多行代码文本 → kind 为 code，未截断', () => {
    const rec = makeRecorder();
    const code = 'function add(a, b) {\n  return a + b;\n}';
    const res = rec.recordText(code);
    expect(res).not.toBeNull();
    const row = db.getRow(res!.id)!;
    expect(row.kind).toBe('code');
    expect(row.truncated).toBe(0);
    expect(row.content).toBe(code);
  });

  it('超过 10 万字符 → 截断到 100000 并置 truncated', () => {
    const rec = makeRecorder();
    const res = rec.recordText('a'.repeat(100001));
    expect(res).not.toBeNull();
    const row = db.getRow(res!.id)!;
    expect(row.content?.length).toBe(100000);
    expect(row.truncated).toBe(1);
  });

  it('空文本 / 只有 \0 的文本不入库', () => {
    const rec = makeRecorder();
    expect(rec.recordText('')).toBeNull();
    expect(rec.recordText('\0\0')).toBeNull();
    expect(db.list({}).length).toBe(0);
  });

  it('richHtml 第 3 参一路传到 db：getRichHtml 能读回，DTO 带 hasRich', () => {
    const rec = makeRecorder();
    const res = rec.recordText('从网页复制的', 'chrome.exe', '<p>从网页复制的</p>')!;
    expect(res).not.toBeNull();
    expect(db.getRichHtml(res.id)).toBe('<p>从网页复制的</p>');
    expect(db.list({}).find((r) => r.id === res.id)?.hasRich).toBe(true);
  });

  it('只有 text/html、没有纯文本：仍然入库，content 用占位描述（不能是一行空白）', () => {
    const rec = makeRecorder();
    const res = rec.recordText('', undefined, '<p>只有富文本</p>');
    expect(res).not.toBeNull();
    const row = db.getRow(res!.id)!;
    expect(row.content).toBe('（富文本内容，无纯文本）');
    expect(db.getRichHtml(res!.id)).toBe('<p>只有富文本</p>');
  });

  it('纯文本与 richHtml 都为空：不入库', () => {
    const rec = makeRecorder();
    expect(rec.recordText('', undefined, '   ')).toBeNull();
    expect(db.list({}).length).toBe(0);
  });

  it('richHtml 超过 RICH_HTML_MAX 时兜底截断（绕开采集层直接调用也不会撑爆库）', () => {
    const rec = makeRecorder();
    const huge = 'x'.repeat(RICH_HTML_MAX + 500);
    const res = rec.recordText('带超长富文本', undefined, huge)!;
    expect(db.getRichHtml(res.id)!.length).toBe(RICH_HTML_MAX);
  });
});

describe('Recorder.recordFiles 文件记录', () => {
  it('路径列表落库：kind=files，getFilePaths 往返一致', () => {
    const rec = makeRecorder();
    const res = rec.recordFiles(['C:\\a.txt', 'C:\\b.txt'])!;
    expect(res).not.toBeNull();
    expect(db.getRow(res.id)!.kind).toBe('files');
    expect(db.getFilePaths(res.id)).toEqual(['C:\\a.txt', 'C:\\b.txt']);
  });

  it('空数组 / 全是空串 / 非数组 都不入库', () => {
    const rec = makeRecorder();
    expect(rec.recordFiles([])).toBeNull();
    expect(rec.recordFiles(['', ''])).toBeNull();
    expect(rec.recordFiles(null as unknown as string[])).toBeNull();
    expect(db.list({}).length).toBe(0);
  });

  it('同一批路径第二次命中去重（touched=true，不产生第二行）', () => {
    const rec = makeRecorder();
    const first = rec.recordFiles(['C:\\same.txt'])!;
    const second = rec.recordFiles(['C:\\same.txt'])!;
    expect(second.id).toBe(first.id);
    expect(second.touched).toBe(true);
    expect(db.list({}).length).toBe(1);
  });

  it('来源应用同样落进 source_app', () => {
    const rec = makeRecorder();
    const res = rec.recordFiles(['C:\\x.txt'], null, 'explorer.exe')!;
    expect(db.list({}).find((r) => r.id === res.id)?.sourceApp).toBe('explorer.exe');
  });
});

describe('Recorder.recordImage 图片落盘 + 落库', () => {
  it('记录入库，images/ 与 thumbs/ 各出现一个文件；删除记录后两个文件都消失', () => {
    const rec = makeRecorder();
    const res = rec.recordImage(fakeImage(320, 240, 3, 2048));
    expect(res).not.toBeNull();
    expect(res!.touched).toBe(false);

    const id = res!.id;
    const row = db.getImageRow(id)!;
    expect(row.width).toBe(320);
    expect(row.height).toBe(240);
    expect(row.bytes).toBe(2048);
    expect(row.image_path).toBe('images/' + id + '.jpg');
    expect(row.thumb_path).toBe('thumbs/' + id + '.png');
    expect(readdirSync(imagesDir(dataDir))).toEqual([id + '.jpg']);
    expect(readdirSync(thumbsDir(dataDir))).toEqual([id + '.png']);

    // v0.3.0 §1.1：删除分两族——软删（remove，不删盘）与硬删（purgeItemsWithFiles，删盘）。
    // 这里钉两件事：软删后行进回收站且**文件仍在**；硬删后文件才消失。
    db.remove(id);
    expect(db.list({ limit: 50 }).some((r) => r.id === id)).toBe(false);
    expect(db.listTrash({}).some((r) => r.id === id)).toBe(true);
    expect(existsSync(join(imagesDir(dataDir), id + '.jpg'))).toBe(true);
    expect(existsSync(join(thumbsDir(dataDir), id + '.png'))).toBe(true);

    const out = purgeItemsWithFiles(db, dataDir, [id], (m: string) => logs.push(m));
    expect(out.removed).toBe(1);
    expect(db.getImageRow(id)).toBeNull();
    expect(existsSync(join(imagesDir(dataDir), id + '.jpg'))).toBe(false);
    expect(existsSync(join(thumbsDir(dataDir), id + '.png'))).toBe(false);
  });

  it('同一张图第二次记录：命中去重（touched），不留下多余文件', () => {
    const rec = makeRecorder();
    const first = rec.recordImage(fakeImage(64, 64, 9, 512))!;
    const second = rec.recordImage(fakeImage(64, 64, 9, 512))!;
    expect(second.touched).toBe(true);
    expect(second.id).toBe(first.id);
    expect(readdirSync(imagesDir(dataDir))).toEqual([first.id + '.jpg']);
    expect(readdirSync(thumbsDir(dataDir))).toEqual([first.id + '.png']);
  });

  it('空图片直接忽略', () => {
    const rec = makeRecorder();
    const empty: NativeImageLike = { ...fakeImage(1, 1), isEmpty: () => true };
    expect(rec.recordImage(empty)).toBeNull();
    expect(db.allImageRows().length).toBe(0);
  });
});

describe('上限淘汰（historyLimit）', () => {
  it('historyLimit=5 时插 8 条 → 只剩最新 5 条', () => {
    db.setSettings({ historyLimit: 5 });
    const rec = makeRecorder();
    for (let i = 0; i < 8; i++) rec.recordText('第 ' + i + ' 条文本');
    const rows = db.list({ limit: 500 });
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.preview)).toEqual([
      '第 7 条文本',
      '第 6 条文本',
      '第 5 条文本',
      '第 4 条文本',
      '第 3 条文本',
    ]);
  });

  it('收藏项不占额度、永不被上限淘汰', () => {
    db.setSettings({ historyLimit: 5 });
    const rec = makeRecorder();
    for (let i = 0; i < 8; i++) rec.recordText('条目 ' + i);
    const before = db.list({ limit: 500 });
    expect(before.length).toBe(5);

    const pinnedId = before[before.length - 1]!.id; // 最旧的一条
    db.togglePin(pinnedId);
    rec.recordText('新条目');

    const after = db.list({ limit: 500 });
    expect(after.filter((r) => !r.pinned).length).toBe(5);
    expect(after.some((r) => r.id === pinnedId && r.pinned)).toBe(true);
  });

  it('按上限淘汰掉图片记录时进回收站，文件留在盘上（软删不删盘）', () => {
    db.setSettings({ historyLimit: 2 });
    const rec = makeRecorder();
    const a = rec.recordImage(fakeImage(10, 10, 1, 128))!;
    const b = rec.recordImage(fakeImage(10, 10, 2, 128))!;
    expect(db.allImageRows().length).toBe(2);

    // 再插一条文本：上限淘汰按**全表行数**算，最旧的图片行（a）被软删（v0.3.0 §1.1）
    rec.recordText('文本一');

    // 活跃列表里没有它了，但行还在回收站（v0.3.0 §1.1：上限淘汰也走软删）。
    expect(db.list({ limit: 50 }).some((r) => r.id === a.id)).toBe(false);
    expect(db.listTrash({}).some((r) => r.id === a.id)).toBe(true);
    // 较新的那张还在活跃列表里
    expect(db.list({ limit: 50 }).some((r) => r.id === b.id)).toBe(true);
  });
});

describe('来源应用（sourceApp）', () => {
  it('normalizeSourceApp：空白 / 空串 / null / undefined 一律当"未知"', () => {
    expect(normalizeSourceApp('notepad.exe')).toBe('notepad.exe');
    expect(normalizeSourceApp('  code.exe  ')).toBe('code.exe');
    expect(normalizeSourceApp('')).toBeUndefined();
    expect(normalizeSourceApp('   ')).toBeUndefined();
    expect(normalizeSourceApp(null)).toBeUndefined();
    expect(normalizeSourceApp(undefined)).toBeUndefined();
  });

  it('带来源的文本照常落库，来源确实写进 source_app；来源未知时也不影响记录本身', () => {
    const rec = makeRecorder();
    const a = rec.recordText('来自记事本', 'notepad.exe');
    const b = rec.recordText('来源未知');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const rows = db.list({});
    expect(rows.length).toBe(2);
    // 「未知」只有一种表示法：DTO 上是 undefined（不是空串、不是 "__unknown__"）
    expect(rows.find((r) => r.id === a!.id)?.sourceApp).toBe('notepad.exe');
    expect(rows.find((r) => r.id === b!.id)?.sourceApp).toBeUndefined();
  });

  it('空串来源被归一化成"未知"（绝不写空字符串），记录照样成功', () => {
    const rec = makeRecorder();
    const res = rec.recordText('空串来源', '   ');
    expect(res).not.toBeNull();
    expect(db.list({}).length).toBe(1);
  });

  it('图片也接受来源参数，照常落盘落库且来源写进 source_app', () => {
    const rec = makeRecorder();
    const res = rec.recordImage(fakeImage(20, 20, 5, 64), null, 'mspaint.exe');
    expect(res).not.toBeNull();
    expect(db.getImageRow(res!.id)).not.toBeNull();
    expect(db.list({}).find((r) => r.id === res!.id)?.sourceApp).toBe('mspaint.exe');
  });

  it('同一内容第二次带不同来源：仍命中去重（不产生第二行）', () => {
    const rec = makeRecorder();
    const first = rec.recordText('同一份内容', 'notepad.exe')!;
    const second = rec.recordText('同一份内容', 'code.exe')!;
    expect(second.id).toBe(first.id);
    expect(second.touched).toBe(true);
    expect(db.list({}).length).toBe(1);
  });
});

/**
 * ★ 端到端可达性（T5 最容易"类型全绿、功能全死"的一段）：
 *   watcher 取前台 exe → 交给 sink（真正的 Recorder）→ db 落 source_app → DTO 带 sourceApp。
 *   全程用真 Recorder + 真 db + 假剪贴板，只有"前台 exe"是注入的。
 */
describe('来源应用端到端：watcher → recorder → db', () => {
  it('从"记事本"复制文本：source_app 一路落库并出现在 DTO 上', async () => {
    const clip = makeClip('', ['text/plain']);
    const rec = makeRecorder(clip);
    rec.baseline();

    const w = new ClipboardWatcher({
      clip,
      recorder: rec,
      intervalMs: 5,
      foregroundExe: async () => 'notepad.exe',
      onTrace: () => {},
    });
    w.start();
    clip.state.text = '从记事本复制的内容';
    await sleep(40);
    await w.whenRecordsSettled();
    w.stop();

    const rows = db.list({});
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceApp).toBe('notepad.exe');
    // 落库的那一列也要对（不只是 DTO 投影）
    expect(db.getRow(rows[0]!.id)!.source_app).toBe('notepad.exe');
  });

  it('前台是 clipchan 自己时不记来源（面板内粘贴回写不产生自引用）', async () => {
    const clip = makeClip('', ['text/plain']);
    const rec = makeRecorder(clip);
    rec.baseline();

    const w = new ClipboardWatcher({
      clip,
      recorder: rec,
      intervalMs: 5,
      foregroundExe: async () => 'clipchan.exe',
      onTrace: () => {},
    });
    w.start();
    clip.state.text = '面板里粘贴回写的';
    await sleep(40);
    await w.whenRecordsSettled();
    w.stop();

    const rows = db.list({});
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceApp).toBeUndefined();
    expect(db.getRow(rows[0]!.id)!.source_app).toBeNull();
  });
});

describe('图片预算淘汰（imageBudgetMB）', () => {
  it('降到预算 80% 以下，收藏图片不被删且文件保留', () => {
    db.setSettings({ imageBudgetMB: 10, historyLimit: 200 });
    let t = 1_000_000;
    const rec = makeRecorder(makeClip(), () => t++);

    const size = 512 * 1024;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = rec.recordImage(fakeImage(100, 100, i + 1, size));
      expect(r).not.toBeNull();
      ids.push(r!.id);
    }
    db.togglePin(ids[0]!); // 收藏最旧的那张
    expect(db.allImageRows().length).toBe(3);

    // 用户把预算调到 1MB，下一次写入触发淘汰
    db.setSettings({ imageBudgetMB: 1 });
    rec.recordText('触发一次写入，让预算淘汰跑起来');

    const rows = db.allImageRows();
    const total = rows.reduce((s, r) => s + (r.bytes ?? 0), 0);
    expect(total).toBeLessThanOrEqual(Math.floor(1024 * 1024 * 0.8));
    expect(rows.some((r) => r.id === ids[0] && r.pinned)).toBe(true);
    expect(existsSync(join(imagesDir(dataDir), ids[0]! + '.jpg'))).toBe(true);

    // 被淘汰的两张，文件也要跟着没
    for (const gone of ids.slice(1)) {
      expect(db.getImageRow(gone)).toBeNull();
      expect(existsSync(join(imagesDir(dataDir), gone + '.jpg'))).toBe(false);
      expect(existsSync(join(thumbsDir(dataDir), gone + '.png'))).toBe(false);
    }
  });
});