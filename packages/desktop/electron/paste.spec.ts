/**
 * Task 6 自动粘贴编排的单测。
 *
 * 只测**纯逻辑与降级分支**：不 spawn 助手 exe、不碰 electron、不碰真剪贴板。
 * db 用真 better-sqlite3 的 `:memory:`（集成用例）或注入假对象（顺序/分支用例）。
 */
import { describe, expect, it } from 'vitest';
import { mapHelperCode, pasteHintOf, type PasteResult } from '@clipchan/core';
import { openDb, type Db, type ItemRow } from './db';
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
  };
}

/** 造一行图片记录（image_path 是相对数据目录的相对路径）。 */
function imageRow(id: string, relPath: string): ItemRow {
  return { ...textRow(id, '', 1000), kind: 'image', content: null, image_path: relPath };
}

/** 假 db：只实现编排用到的方法，记录调用顺序。 */
function fakeDb(row: ItemRow | null, events: string[] = []): Db {
  return {
    getRow: () => {
      events.push('getRow');
      return row;
    },
    touch: () => {
      events.push('touch');
    },
    list: () => [],
  } as unknown as Db;
}

/** 假 writer：记录写入内容与顺序（真实现内部会先调 watcher.suppressNext()）。 */
function fakeWriter(events: string[] = []): ClipboardWriter & { texts: string[]; images: Buffer[] } {
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
    noteForeground: () => {},
    notePanelShown: async () => {},
  } as unknown as TargetTracker;
}

// ---------------- TargetTracker ----------------

describe('TargetTracker（一次性消费 / Review Focus 2）', () => {
  it('consume() 返回一次句柄后再调返回 null（用完即弃）', () => {
    const t = new TargetTracker();
    t.noteForeground(0x1001, 0x2002);
    expect(t.consume()).toBe(0x1001);
    expect(t.consume()).toBeNull();
    expect(t.consume()).toBeNull();
  });

  it('记下的句柄等于自身 hwnd 时视为无目标', () => {
    const t = new TargetTracker();
    t.noteForeground(0x2002, 0x2002);
    expect(t.consume()).toBeNull();
    expect(t.lastForeign()).toBeNull();
  });

  it('面板唤起句柄为空时回退到 lastForeign()', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => 0x3003 } });
    t.noteForeground(0, 0x2002); // 唤起那一刻没记到窗口
    await t.notePanelShown(0x2002); // 面板显示时查到外部前台窗口
    expect(t.lastForeign()).toBe(0x3003);
    expect(t.consume()).toBe(0x3003);
  });

  it('两者都无 → null', () => {
    const t = new TargetTracker();
    expect(t.consume()).toBeNull();
  });

  it('优先用唤起时记下的句柄；消费一次后 lastForeign 也一起清空', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => 0x3003 } });
    await t.notePanelShown(0x2002);
    t.noteForeground(0x1001, 0x2002);
    expect(t.consume()).toBe(0x1001);
    expect(t.consume()).toBeNull(); // 陈旧句柄绝不复用（含回退槽位）
  });

  it('notePanelShown 查到的是自己 → 不记；查不到 → 不覆盖已有值', async () => {
    const values = [0x2002, 0, 0x4004];
    const t = new TargetTracker({ foreground: { foreground: async () => values.shift() ?? 0 } });
    await t.notePanelShown(0x2002); // 自己
    expect(t.lastForeign()).toBeNull();
    await t.notePanelShown(0x2002); // 查不到
    expect(t.lastForeign()).toBeNull();
    await t.notePanelShown(0x2002); // 外部窗口
    expect(t.lastForeign()).toBe(0x4004);
  });

  it('没有 foreground 来源（助手不可用）时 notePanelShown 是 no-op 且不抛', async () => {
    const t = new TargetTracker();
    await expect(t.notePanelShown(0x2002)).resolves.toBeUndefined();
    expect(t.lastForeign()).toBeNull();
  });

  it('前台查询抛异常时不抛、不记', async () => {
    const t = new TargetTracker({
      foreground: {
        foreground: async () => {
          throw new Error('助手没了');
        },
      },
    });
    await expect(t.notePanelShown(0x2002)).resolves.toBeUndefined();
    expect(t.lastForeign()).toBeNull();
  });
});

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

  it('helper.available===false → {send-failed} 且**一次都不调** helper.paste', async () => {
    const helper = fakeHelper({ ok: true }, false);
    const writer = fakeWriter();
    const svc = new PasteService({
      db: fakeDb(textRow('a1', 'x')),
      helper,
      tracker: fakeTracker(0x5555),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteItem('a1')).toEqual({ ok: false, reason: 'send-failed' });
    expect(helper.calls).toEqual([]);
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
    const sendFailed = await mk(fakeHelper({ ok: true }, false), 0x5555).pasteItem('a1');

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
      const tracker = new TargetTracker();
      tracker.noteForeground(0x8888, 0x9999);
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

  it('helper.available===false → {send-failed} 且一次都不调 helper.paste', async () => {
    const events: string[] = [];
    const writer = fakeWriter(events);
    const helper = fakeHelper({ ok: true }, false);
    const svc = new PasteService({
      db: fakeDb(null, events),
      helper,
      tracker: fakeTracker(0x5555, events),
      getSettings: () => ({ autoPaste: true }),
      writer,
    });

    expect(await svc.pasteText('x')).toEqual({ ok: false, reason: 'send-failed' });
    expect(helper.calls).toEqual([]);
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
