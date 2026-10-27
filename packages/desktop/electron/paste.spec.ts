/**
 * Task 6 自动粘贴编排的单测。
 *
 * 只测**纯逻辑与降级分支**：不 spawn 助手 exe、不碰 electron、不碰真剪贴板。
 * db 用真 better-sqlite3 的 `:memory:`（集成用例）或注入假对象（顺序/分支用例）。
 */
import { describe, expect, it } from 'vitest';
import { mapHelperCode, pasteHintOf, type PasteResult } from '@clipchan/core';
import { TEXT_LIMIT, openDb, type Db, type ItemRow } from './db';
import { TargetTracker } from './target-tracker';
import { PasteService, type ClipboardWriter, type PasteHelper } from './paste';

// ---------------- 测试替身 ----------------

/** 造一行文本记录（只填被编排读到的字段）。 */
function textRow(id: string, content: string, createdAt = 1000): ItemRow {
  return {
    id,
    kind: 'text',
    content,
    content_hash: 'h-' + id,
    image_path: null,
    image_hash: null,
    thumb_path: null,
    width: null,
    height: null,
    bytes: null,
    source: 'clip',
    pinned: 0,
    truncated: 0,
    created_at: createdAt,
    seq: createdAt,
    deleted_at: null,
    source_app: null,
    file_paths: null,
    rich_html: null,
    search_index: null,
  };
}

/** 造一行文件记录（路径走 db.getFilePaths，不在 row 上直接读）。 */
function filesRow(id: string, paths: string[]): ItemRow {
  return { ...textRow(id, '', 1000), kind: 'files', content: null, file_paths: JSON.stringify(paths) };
}

/** 造一行图片记录（image_path 是相对数据目录的相对路径）。 */
function imageRow(id: string, relPath: string): ItemRow {
  return { ...textRow(id, '', 1000), kind: 'image', content: null, image_path: relPath };
}

/** 假 db 的可选行为：全文 / 文件路径 / 富文本 / 多行都从这里注入。 */
interface FakeDbOpts {
  /** getText 固定返回它（不传则回该行 content）。 */
  text?: string;
  /** getFilePaths 的返回值（默认空数组）。 */
  filePaths?: string[];
  /** getRichHtml 的返回值（默认 null = 没有 html）。 */
  richHtml?: string | null;
  /** 多行场景：getRow / getText 按 id 查这张表。 */
  rows?: Record<string, ItemRow>;
  /** 每次 touch 记下 id（批量粘贴要验"参与的行都被 touch"）。 */
  touched?: string[];
}

/**
 * 假 db：只实现编排用到的方法，记录调用顺序。
 *
 * ★ 只有 getRow / touch 进 events（顺序断言依赖它）；getText / getFilePaths /
 *   getRichHtml 是"读数据"，进 events 会把现有顺序断言全部打乱。
 */
function fakeDb(row: ItemRow | null, events: string[] = [], opts: FakeDbOpts = {}): Db {
  const rows = opts.rows;
  return {
    getRow: (id: string) => {
      events.push('getRow');
      return rows ? (rows[id] ?? null) : row;
    },
    getText: (id: string) => {
      if (opts.text !== undefined) return opts.text;
      return rows ? (rows[id]?.content ?? '') : (row?.content ?? '');
    },
    getFilePaths: () => opts.filePaths ?? [],
    getRichHtml: () => opts.richHtml ?? null,
    touch: (id: string) => {
      events.push('touch');
      opts.touched?.push(id);
    },
    list: () => [],
  } as unknown as Db;
}

/** 假 writer：记录写入内容与顺序（真实现内部会先调 watcher.suppressNext()）。 */
function fakeWriter(events: string[] = []): ClipboardWriter & {
  texts: string[];
  images: Buffer[];
  files: string[][];
  rich: Array<[string, string]>;
} {
  const texts: string[] = [];
  const images: Buffer[] = [];
  const files: string[][] = [];
  const rich: Array<[string, string]> = [];
  return {
    texts,
    images,
    files,
    rich,
    writeText: (t: string) => {
      events.push('writeText');
      texts.push(t);
    },
    writeImage: (img: Buffer) => {
      events.push('writeImage');
      images.push(img);
    },
    writeFiles: (paths: string[]) => {
      events.push('writeFiles');
      files.push(paths);
    },
    writeRich: (html: string, text: string) => {
      events.push('writeRich');
      rich.push([html, text]);
    },
  };
}

/** 只有纯文本 + 图片两条路的老 writer（手机端 / 老平台）：用来验"能力缺失时诚实回退"。 */
function bareWriter(events: string[] = []): ClipboardWriter & { texts: string[]; images: Buffer[] } {
  const texts: string[] = [];
  const images: Buffer[] = [];
  return {
    texts,
    images,
    writeText: (t: string) => {
      events.push('writeText');
      texts.push(t);
    },
    writeImage: (img: Buffer) => {
      events.push('writeImage');
      images.push(img);
    },
  };
}

/** 假助手：paste 的返回值由调用方给定（模拟 HelperClient 已映射过的 PasteResult）。 */
function fakeHelper(result: PasteResult, available = true): PasteHelper & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    available,
    paste: async (hwnd: number) => {
      calls.push(hwnd);
      return result;
    },
  };
}

/** 假 tracker：consume 固定返回给定句柄，并记录调用顺序。 */
function fakeTracker(hwnd: number | null, events: string[] = []): TargetTracker {
  return {
    consume: () => {
      events.push('consume');
      return hwnd;
    },
    lastForeign: () => null,
    captureTarget: async () => 'captured',
    noteForeground: () => {},
    notePanelShown: async () => {},
  } as unknown as TargetTracker;
}

// ---------------- PasteService 编排 ----------------

describe('PasteService.pasteItem 编排顺序', () => {
  it('① 取项 → ② 写剪贴板 → ③ touch → ④ consume → ⑥ 调助手', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const helper = fakeHelper({ ok: true });
    const db = fakeDb(textRow('a1', '你好'), events);
    const tracker = fakeTracker(0x5555, events);
    const svc = new PasteService({ db, helper, tracker, getSettings: () => ({ autoPaste: true }), writer });

    const r = await svc.pasteItem('a1');

    expect(r).toEqual({ ok: true });
    expect(events).toEqual(['getRow', 'writeText', 'touch', 'consume']);
    expect(writer.texts).toEqual(['你好']);
    expect(helper.calls).toEqual([0x5555]);
  });

  it('writer 必须在 db.touch 之前被调用（顺序敏感）', async () => {
    const events: string[] = [];
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x'), events),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x1, events),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });
    await svc.pasteItem('a1');
    expect(events.indexOf('writeText')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('writeText')).toBeLessThan(events.indexOf('touch'));
  });

  it('目标为 null → {no-target} 且**不调助手**（但内容已进剪贴板）', async () => {
    const writer = fakeWriter();
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x')),
      helper,
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    const r = await svc.pasteItem('a1');

    expect(r).toEqual({ ok: false, reason: 'no-target' });
    expect(helper.calls).toEqual([]);
    expect(writer.texts).toEqual(['x']);
  });

  it('自动粘贴开关关闭 → {no-target} 且不调助手（只复制）', async () => {
    const helper = fakeHelper({ ok: true });
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x')),
      helper,
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    expect(await svc.pasteItem('a1')).toEqual({ ok: false, reason: 'no-target' });
    expect(helper.calls).toEqual([]);
    expect(writer.texts).toEqual(['x']);
  });

  it('helper.available===false 时编排层**不预判**，照样调 paste() 由助手层决定（可自愈）', async () => {
    // ★ 语义变更：可用性判断已下沉到 HelperClient（它会自己 ensureChild 重启），
    //   编排层再拦一道会挡住"助手已死但可重启"的自愈路径。
    const helper = fakeHelper({ ok: false, reason: 'send-failed' }, false);
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x')),
      helper,
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteItem('a1')).toEqual({ ok: false, reason: 'send-failed' });
    expect(helper.calls).toEqual([0x5555]); // 调用发生了，失败由助手层如实上报
    expect(writer.texts).toEqual(['x']); // 复制仍然成功
  });

  it('助手结果原样透传（不重复映射）：0/1/3/6/2/4/5/7', async () => {
    for (const code of [0, 1, 3, 6, 2, 4, 5, 7]) {
      const helper = fakeHelper(mapHelperCode(code));
      const svc = new PasteService({
        db: fakeDb(textRow('a1', 'x')),
        helper,
        tracker: fakeTracker(0x5555),
        getSettings: () => ({ autoPaste: true }),
        writer: fakeWriter(),
      });
      expect(await svc.pasteItem('a1')).toEqual(mapHelperCode(code));
      expect(helper.calls).toEqual([0x5555]);
    }
  });

  it('记录不存在 → {no-target}，不写剪贴板、不调助手', async () => {
    const writer = fakeWriter();
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(null),
      helper,
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteItem('missing')).toEqual({ ok: false, reason: 'no-target' });
    expect(writer.texts).toEqual([]);
    expect(helper.calls).toEqual([]);
  });

  it('writer 抛异常（剪贴板被占用）→ {send-failed}，不 touch、不消耗目标', async () => {
    const events: string[] = [];
    const writer: ClipboardWriter = {
      writeText: () => {
        events.push('writeText');
        throw new Error('剪贴板被占用');
      },
      writeImage: () => {},
    };
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x'), events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteItem('a1')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual(['getRow', 'writeText']);
    expect(helper.calls).toEqual([]);
  });

  it('空 id → {send-failed}，不碰 db', async () => {
    const events: string[] = [];
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x'), events),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });
    expect(await svc.pasteItem('')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual([]);
  });

  it('图片记录：读原图字节并交给 writeImage（相对路径经 imageAbs 解析）', async () => {
    const writer = fakeWriter();
    const seen: string[] = [];
    const svc = new PasteService({
      db: fakeDb(imageRow('i1', 'images/i1.jpg')),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
      dataDir: 'C:\\data\\Clipchan',
      readImage: (abs) => {
        seen.push(abs);
        return Buffer.from('JPEG-BYTES');
      },
    });

    expect(await svc.pasteItem('i1')).toEqual({ ok: true });
    expect(seen).toEqual(['C:\\data\\Clipchan\\images\\i1.jpg']);
    expect(writer.images).toHaveLength(1);
    expect(writer.images[0]!.toString()).toBe('JPEG-BYTES');
    expect(writer.texts).toEqual([]);
  });

  it('图片没有 dataDir / 没有 image_path → {send-failed}，不写剪贴板', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(imageRow('i1', 'images/i1.jpg')),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });
    expect(await svc.pasteItem('i1')).toEqual({ ok: false, reason: 'send-failed' });
    expect(writer.images).toEqual([]);
  });

  it('三种 reason 在界面文案上仍是三条不同提示', async () => {
    const mk = (helper: PasteHelper, hwnd: number | null): PasteService =>
      new PasteService({
        db: fakeDb(textRow('a1', 'x')),
        helper,
        tracker: fakeTracker(hwnd),
        getSettings: () => ({ autoPaste: true }),
        writer: fakeWriter(),
      });

    const noTarget = await mk(fakeHelper({ ok: true }), null).pasteItem('a1');
    const elevated = await mk(fakeHelper(mapHelperCode(6)), 0x5555).pasteItem('a1');
    const sendFailed = await mk(fakeHelper({ ok: false, reason: 'send-failed' }), 0x5555).pasteItem('a1');

    const hints = [pasteHintOf(noTarget), pasteHintOf(elevated), pasteHintOf(sendFailed)];
    expect(new Set(hints).size).toBe(3);
    expect(hints[1]).toContain('管理员');
  });
});

// ---------------- 真 db 集成：touch 刷新 + 自我抑制不产生新记录 ----------------

describe('PasteService 与真 db 的集成（Review Focus 1）', () => {
  it('粘贴后 created_at/seq 变新并排到最前，且不产生新记录（suppressNext 生效）', async () => {
    const db = openDb(':memory:');
    try {
      const old = db.insertText('旧内容', { now: 1000, seq: 1 });
      const fresh = db.insertText('新内容', { now: 2000, seq: 2 });
      expect(db.list()[0]!.id).toBe(fresh.id);

      const writer = fakeWriter();
      const helper = fakeHelper({ ok: true });
      const svc = new PasteService({
        db,
        helper,
        tracker: fakeTracker(0x7777),
        getSettings: () => ({ autoPaste: true }),
        writer,
      });

      const r = await svc.pasteItem(old.id);

      expect(r).toEqual({ ok: true });
      expect(writer.texts).toEqual(['旧内容']);
      const rows = db.list();
      expect(rows).toHaveLength(2); // 没有多出一条（自己这一跳没被记下来）
      expect(rows[0]!.id).toBe(old.id); // 刚粘贴的排最前
      const row = db.getRow(old.id)!;
      expect(row.created_at).toBeGreaterThan(2000);
      expect(row.seq).toBeGreaterThan(2);
      // 一次性消费：目标已被取走，再取是 null
      expect(helper.calls).toEqual([0x7777]);
    } finally {
      db.close();
    }
  });

  it('真 db + 真 TargetTracker：consume 之后目标清空，第二次粘贴不再粘同一个窗口', async () => {
    const db = openDb(':memory:');
    try {
      const a = db.insertText('甲', { now: 1000 });
      const b = db.insertText('乙', { now: 2000 });
      // 走生产路径：唤起前捕获（captureTarget）写进 pending，再被 consume 取走。
      const tracker = new TargetTracker({ foreground: { foreground: async () => 0x8888 } });
      expect(await tracker.captureTarget(0x9999)).toBe('captured');
      const helper = fakeHelper({ ok: true });
      const svc = new PasteService({
        db,
        helper,
        tracker,
        getSettings: () => ({ autoPaste: true }),
        writer: fakeWriter(),
      });

      expect(await svc.pasteItem(a.id)).toEqual({ ok: true });
      expect(helper.calls).toEqual([0x8888]);
      // 第二次：目标已用完 → 诚实回退，不再调助手（陈旧 HWND 不复用）
      expect(await svc.pasteItem(b.id)).toEqual({ ok: false, reason: 'no-target' });
      expect(helper.calls).toEqual([0x8888]);
    } finally {
      db.close();
    }
  });
});

// ---------------- PasteService.pasteText（Task 7：把优化结果写进剪贴板） ----------------

describe('PasteService.pasteText 编排（与 pasteItem 同构，但不查库、不 touch）', () => {
  it('② 写剪贴板 → ④ consume → ⑥ 调助手；**不 getRow、不 touch**', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      // 假 db 的行是 null：pasteText 一旦查库就会走错分支，这里能立刻暴露。
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteText('优化后的提示词')).toEqual({ ok: true });
    expect(events).toEqual(['writeText', 'consume']);
    expect(events).not.toContain('getRow');
    expect(events).not.toContain('touch');
    expect(writer.texts).toEqual(['优化后的提示词']);
    expect(helper.calls).toEqual([0x5555]);
  });

  it('空文本 → {send-failed}，不写剪贴板、不调助手、不碰 db', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteText('')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual([]);
    expect(writer.texts).toEqual([]);
    expect(helper.calls).toEqual([]);
  });

  it('自动粘贴开关关闭 → {no-target} 且不调助手（内容已进剪贴板）', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    expect(await svc.pasteText('优化后的提示词')).toEqual({ ok: false, reason: 'no-target' });
    expect(events).toEqual(['writeText', 'consume']);
    expect(events).not.toContain('touch');
    expect(writer.texts).toEqual(['优化后的提示词']);
    expect(helper.calls).toEqual([]);
  });

  it('目标为 null → {no-target} 且不调助手', async () => {
    const events: string[] = [];
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(null, events),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });

    expect(await svc.pasteText('x')).toEqual({ ok: false, reason: 'no-target' });
    expect(events).not.toContain('touch');
    expect(helper.calls).toEqual([]);
  });

  it('helper.available===false 时 pasteText 也不预判，直接交给助手层', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const helper = fakeHelper({ ok: false, reason: 'send-failed' }, false);
    const svc = new PasteService({
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteText('x')).toEqual({ ok: false, reason: 'send-failed' });
    expect(helper.calls).toEqual([0x5555]);
    expect(writer.texts).toEqual(['x']); // 复制仍然成功
    expect(events).not.toContain('touch');
  });

  it('助手结果原样透传（不重复映射）', async () => {
    for (const code of [0, 1, 3, 6, 2, 4, 5, 7]) {
      const helper = fakeHelper(mapHelperCode(code));
      const svc = new PasteService({
        db: fakeDb(null, []),
        helper,
        tracker: fakeTracker(0x5555, []),
        getSettings: () => ({ autoPaste: true }),
        writer: fakeWriter(),
      });
      expect(await svc.pasteText('x')).toEqual(mapHelperCode(code));
      expect(helper.calls).toEqual([0x5555]);
    }
  });

  it('writer 抛异常（剪贴板被占用）→ {send-failed}，不消耗目标、不 touch', async () => {
    const events: string[] = [];
    const writer: ClipboardWriter = {
      writeText: () => {
        events.push('writeText');
        throw new Error('剪贴板被占用');
      },
      writeImage: () => {},
    };
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteText('x')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual(['writeText']);
    expect(events).not.toContain('touch');
    expect(helper.calls).toEqual([]);
  });

  it('helper.paste 抛异常 → {send-failed}（压成诚实回退）', async () => {
    const events: string[] = [];
    const helper: PasteHelper = {
      available: true,
      paste: async () => {
        events.push('paste');
        throw new Error('注入失败');
      },
    };
    const svc = new PasteService({
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });

    expect(await svc.pasteText('x')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual(['writeText', 'consume', 'paste']);
    expect(events).not.toContain('touch');
  });
});

describe('PasteService.copyItem（只复制，不粘贴）', () => {
  it('只写剪贴板：不 touch、不 consume、不调助手', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '你好'), events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    const r = await svc.copyItem('a1');

    expect(r).toEqual({ ok: true });
    expect(events).toEqual(['getRow', 'writeText']);
    expect(writer.texts).toEqual(['你好']);
    expect(helper.calls).toEqual([]);
  });

  it('成功回 {ok:true} 而不是 COPY_ONLY（no-target 是粘贴语义，不能混用）', async () => {
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x')),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer: fakeWriter(),
    });

    const r = await svc.copyItem('a1');

    expect(r.ok).toBe(true);
    expect(r).not.toEqual({ ok: false, reason: 'no-target' });
  });

  it('自动粘贴开着也照样只复制（copyItem 不看 autoPaste）', async () => {
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x')),
      helper,
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(),
    });

    await svc.copyItem('a1');

    expect(helper.calls).toEqual([]);
  });

  it('图片记录：写图片字节，不写文本', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(imageRow('i1', 'images/a.png')),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
      dataDir: 'C:/data',
      readImage: () => Buffer.from([1, 2, 3]),
    });

    const r = await svc.copyItem('i1');

    expect(r).toEqual({ ok: true });
    expect(writer.images).toHaveLength(1);
    expect(writer.texts).toEqual([]);
  });

  it('记录不存在 → {no-target}，不写剪贴板', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(null),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.copyItem('gone')).toEqual({ ok: false, reason: 'no-target' });
    expect(writer.texts).toEqual([]);
  });

  it('空 id → {send-failed}，不碰 db', async () => {
    const events: string[] = [];
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x'), events),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });

    expect(await svc.copyItem('')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual([]);
  });

  it('剪贴板被占用（writer 抛）→ {send-failed}，不假装成功', async () => {
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x')),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer: {
        writeText: () => {
          throw new Error('剪贴板被锁');
        },
        writeImage: () => {},
      },
    });

    expect(await svc.copyItem('a1')).toEqual({ ok: false, reason: 'send-failed' });
  });

  it('空文本记录 → {send-failed}（不把空串塞进剪贴板）', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '')),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.copyItem('a1')).toEqual({ ok: false, reason: 'send-failed' });
    expect(writer.texts).toEqual([]);
  });
});

// ---------------- 出方向 v0.6.0：写文件 / 纯文本 / 批量 / 富文本 ----------------

describe('PasteService 写文件记录（P0-1）', () => {
  it('copyItem：writeFiles 收到 getFilePaths 的同一批路径，回 {ok:true}', async () => {
    const paths = ['D:\\报告\\a.pdf', 'D:\\报告\\b.xlsx'];
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', paths), [], { filePaths: paths }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    const r = await svc.copyItem('f1');

    expect(r).toEqual({ ok: true });
    expect(writer.files).toEqual([paths]);
    // 写文件只能写 FileNameW：再写一次文本会把文件格式清掉。
    expect(writer.texts).toEqual([]);
  });

  it('pasteItem + autoPaste 关闭：写了文件后按现有约定回 {no-target}', async () => {
    const paths = ['D:\\a.txt'];
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', paths), [], { filePaths: paths }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    expect(await svc.pasteItem('f1')).toEqual({ ok: false, reason: 'no-target' });
    expect(writer.files).toEqual([paths]);
  });

  it('getFilePaths 回空 → {missing}，writer 一次都没被调', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', []), events, { filePaths: [] }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteItem('f1')).toEqual({ ok: false, reason: 'missing' });
    expect(events).toEqual(['getRow']);
    expect(writer.files).toEqual([]);
    expect(writer.texts).toEqual([]);
  });

  it('getFilePaths 回空时 copyItem 也回 {missing}（不假装复制成功）', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', []), [], { filePaths: [] }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.copyItem('f1')).toEqual({ ok: false, reason: 'missing' });
    expect(writer.files).toEqual([]);
  });

  it('writer 没有 writeFiles → {no-target}，且绝不退回 writeText', async () => {
    const paths = ['D:\\a.txt'];
    const writer = bareWriter();
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', paths), [], { filePaths: paths }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.copyItem('f1')).toEqual({ ok: false, reason: 'no-target' });
    expect(writer.texts).toEqual([]);
  });

  it('writer.writeFiles 回 false（助手写不出真 CF_HDROP）→ {send-failed}，不假装成功', async () => {
    const events: string[] = [];
    const paths = ['D:\a.txt'];
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', paths), events, { filePaths: paths }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer: {
        writeText: () => {},
        writeImage: () => {},
        writeFiles: async () => false,
      },
    });

    expect(await svc.copyItem('f1')).toEqual({ ok: false, reason: 'send-failed' });
    // 失败不能 touch、不能消耗目标窗口。
    expect(events).toEqual(['getRow']);
  });

  it('writer.writeFiles 回 undefined（老 writer 的 void）→ 按尽力写了处理', async () => {
    const paths = ['D:\a.txt'];
    const writer = bareWriter();
    // 模拟老签名：只写不回报。
    (writer as { writeFiles?: (p: string[]) => void }).writeFiles = () => {};
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', paths), [], { filePaths: paths }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.copyItem('f1')).toEqual({ ok: true });
  });

  it('writer.writeFiles 抛异常 → {send-failed}，不 touch、不消耗目标', async () => {
    const events: string[] = [];
    const paths = ['D:\\a.txt'];
    const svc = new PasteService({
      db: fakeDb(filesRow('f1', paths), events, { filePaths: paths }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer: {
        writeText: () => {},
        writeImage: () => {},
        writeFiles: () => {
          throw new Error('剪贴板被锁');
        },
      },
    });

    expect(await svc.pasteItem('f1')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual(['getRow']);
  });
});

describe('PasteService.pastePlain（P2-9 一键纯文本）', () => {
  it('文本行：写的是 db.getText 的全文，不查 getRichHtml', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '截断的预览'), [], { text: '完整全文', richHtml: '<b>完整全文</b>' }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pastePlain('a1')).toEqual({ ok: true });
    expect(writer.texts).toEqual(['完整全文']);
    expect(writer.rich).toEqual([]);
  });

  it('图片行：仍写原图字节（"纯文本"对图片没有意义）', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(imageRow('i1', 'images/a.png')),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
      dataDir: 'C:/data',
      readImage: () => Buffer.from([9]),
    });

    expect(await svc.pastePlain('i1')).toEqual({ ok: true });
    expect(writer.images).toHaveLength(1);
    expect(writer.texts).toEqual([]);
  });

  it('空文本 → {missing}，不写剪贴板、不 touch', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const svc = new PasteService({
      db: fakeDb(textRow('a1', ''), events, { text: '' }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pastePlain('a1')).toEqual({ ok: false, reason: 'missing' });
    expect(events).toEqual(['getRow']);
    expect(writer.texts).toEqual([]);
  });

  it('记录不存在 → {no-target}，不写剪贴板', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(null),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pastePlain('gone')).toEqual({ ok: false, reason: 'no-target' });
    expect(writer.texts).toEqual([]);
  });

  it('空 id → {send-failed}，不碰 db', async () => {
    const events: string[] = [];
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x'), events),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });

    expect(await svc.pastePlain('')).toEqual({ ok: false, reason: 'send-failed' });
    expect(events).toEqual([]);
  });

  it('与 pasteItem 同构：写完后 touch 并调助手', async () => {
    const events: string[] = [];
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x'), events, { text: 'x' }),
      helper,
      tracker: fakeTracker(0x7777, events),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });

    expect(await svc.pastePlain('a1')).toEqual({ ok: true });
    expect(events).toEqual(['getRow', 'writeText', 'touch', 'consume']);
    expect(helper.calls).toEqual([0x7777]);
  });
});

describe('PasteService.pasteMany（P2-8 批量粘贴）', () => {
  it('两行按入参顺序拼成 a\nb', async () => {
    const events: string[] = [];
    const rows = { a1: textRow('a1', 'a', 1), b1: textRow('b1', 'b', 2) };
    const writer = fakeWriter(events);
    const svc = new PasteService({
      db: fakeDb(null, events, { rows }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    expect(await svc.pasteMany(['a1', 'b1'])).toEqual({ ok: false, reason: 'no-target' });
    expect(writer.texts).toEqual(['a\nb']);
  });

  it('图片行被跳过（这是语义不是 bug），文本行照常拼', async () => {
    const rows = { a1: textRow('a1', 'a', 1), i1: imageRow('i1', 'images/i.png'), b1: textRow('b1', 'b', 3) };
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(null, [], { rows }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    await svc.pasteMany(['a1', 'i1', 'b1']);

    expect(writer.texts).toEqual(['a\nb']);
    expect(writer.images).toEqual([]);
  });

  it('全空 / 全图片 / 记录都不存在 → {missing}，不写剪贴板', async () => {
    const rows = { i1: imageRow('i1', 'images/i.png'), e1: textRow('e1', '', 1) };
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(null, [], { rows }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    expect(await svc.pasteMany(['i1', 'e1', 'gone'])).toEqual({ ok: false, reason: 'missing' });
    expect(writer.texts).toEqual([]);
  });

  it('空数组 → {missing}，不碰 db', async () => {
    const events: string[] = [];
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'a'), events),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null, events),
      getSettings: () => ({ autoPaste: false }),
      writer: fakeWriter(events),
    });

    expect(await svc.pasteMany([])).toEqual({ ok: false, reason: 'missing' });
    expect(events).toEqual([]);
  });

  it('超过 TEXT_LIMIT 被截断且保留头部', async () => {
    const long = 'a'.repeat(60000);
    const rows = { a1: textRow('a1', long, 1), b1: textRow('b1', 'b'.repeat(60000), 2) };
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(null, [], { rows }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    await svc.pasteMany(['a1', 'b1']);

    const body = writer.texts[0]!;
    expect(body.length).toBe(TEXT_LIMIT);
    expect(body.startsWith('a'.repeat(100))).toBe(true);
    // 拼接后是 60000 个 a + 换行 + 60000 个 b，截断到 TEXT_LIMIT 后仍以 b 结尾
    expect(body.endsWith('b')).toBe(true);
  });

  it('参与拼接的行都被 touch，被跳过的行不 touch', async () => {
    const rows = { a1: textRow('a1', 'a', 1), i1: imageRow('i1', 'images/i.png'), e1: textRow('e1', '', 3) };
    const touched: string[] = [];
    const svc = new PasteService({
      db: fakeDb(null, [], { rows, touched }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer: fakeWriter(),
    });

    await svc.pasteMany(['a1', 'i1', 'e1']);

    expect(touched).toEqual(['a1']);
  });

  it('拼好后仍走 consume + 助手（autoPaste 开着时）', async () => {
    const events: string[] = [];
    const rows = { a1: textRow('a1', 'a', 1), b1: textRow('b1', 'b', 2) };
    const helper = fakeHelper({ ok: true });
    const svc = new PasteService({
      db: fakeDb(null, events, { rows }),
      helper,
      tracker: fakeTracker(0x3333, events),
      getSettings: () => ({ autoPaste: true }),
      writer: fakeWriter(events),
    });

    expect(await svc.pasteMany(['a1', 'b1'])).toEqual({ ok: true });
    expect(events).toEqual(['getRow', 'getRow', 'writeText', 'touch', 'touch', 'consume']);
    expect(helper.calls).toEqual([0x3333]);
  });
});

describe('PasteService 富文本粘贴（P2-7 出方向）', () => {
  it('getRichHtml 非空且 writer 有 writeRich → 走 writeRich，不再 writeText', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '粗体'), [], { richHtml: '<b>粗体</b>' }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    expect(await svc.copyItem('a1')).toEqual({ ok: true });
    expect(writer.rich).toEqual([['<b>粗体</b>', '粗体']]);
    expect(writer.texts).toEqual([]);
  });

  it('writer 没有 writeRich → 退回 writeText（不丢内容）', async () => {
    const writer = bareWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '粗体'), [], { richHtml: '<b>粗体</b>' }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    expect(await svc.copyItem('a1')).toEqual({ ok: true });
    expect(writer.texts).toEqual(['粗体']);
  });

  it('getRichHtml 为 null → 走 writeText', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '纯文本'), [], { richHtml: null }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    await svc.copyItem('a1');

    expect(writer.texts).toEqual(['纯文本']);
    expect(writer.rich).toEqual([]);
  });

  it('getRichHtml 为空串 → 走 writeText（空 html 不算富文本）', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '纯文本'), [], { richHtml: '' }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(null),
      getSettings: () => ({ autoPaste: false }),
      writer,
    });

    await svc.copyItem('a1');

    expect(writer.rich).toEqual([]);
    expect(writer.texts).toEqual(['纯文本']);
  });

  it('pasteItem 也走 writeRich（富文本分支在共用方法里）', async () => {
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', '粗体'), [], { richHtml: '<i>粗体</i>' }),
      helper: fakeHelper({ ok: true }),
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteItem('a1')).toEqual({ ok: true });
    expect(writer.rich).toEqual([['<i>粗体</i>', '粗体']]);
  });
});
