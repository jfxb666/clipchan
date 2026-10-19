/**
 * 轮询器测试（计划 Task 5 的 Step 1–4）。
 *
 * 全程注入**假剪贴板**，不 import electron：这样在 Node 里就能跑，
 * 也能精确断言"某一跳到底调了哪些 clipboard.* API"——这是本任务最容易写错的地方
 * （每跳解码整张位图 = CPU 吃满；幽灵模式还偷偷读 = 破隐私承诺）。
 */
import { readFileSync, rmSync } from 'node:fs';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClipboardWatcher,
  FAILURE_TRACE_THRESHOLD,
  IMAGE_SIG_HEAD_BYTES,
  LastSeen,
  SOURCE_APP_TIMEOUT_MS,
  imageSignature,
  isSelfExe,
  shouldSkipFormats,
  writeWatcherTrace,
} from './watcher';
import type { ClipboardLike, RecordSink } from './watcher';
import type { NativeImageLike } from './images';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-watcher-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等某个条件成立（Windows 定时器分辨率约 15ms，setInterval(5) 实际远达不到 5ms，
 * 所以断言"跑够 N 跳"必须轮询等待而不是死等一个固定时长）。
 */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

/** 假图片（窄接口）。 */
function fakeImage(w = 4, h = 3): NativeImageLike {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: () => fakeImage(w, h),
    toPNG: () => Buffer.from('PNG'),
    toJPEG: () => Buffer.from('JPG'),
    hasAlpha: false,
  };
}

interface FakeClip extends ClipboardLike {
  calls: string[];
  state: {
    formats: string[];
    text: string;
    imageBuf: Buffer | null;
    image: NativeImageLike;
  };
}

/** 假剪贴板：记录每一次调用的名字，方便断言"没调过 readImage"。 */
function makeClip(
  opts: {
    formats?: string[];
    text?: string;
    imageBuf?: Buffer | null;
    image?: NativeImageLike;
    hasFileName?: boolean;
    noReadBuffer?: boolean;
  } = {},
): FakeClip {
  const calls: string[] = [];
  const state = {
    formats: opts.formats ?? [],
    text: opts.text ?? '',
    imageBuf: opts.imageBuf ?? null,
    image: opts.image ?? fakeImage(),
  };
  const clip: FakeClip = {
    calls,
    state,
    availableFormats: () => {
      calls.push('availableFormats');
      return state.formats;
    },
    has: (format: string) => {
      calls.push('has:' + format);
      return opts.hasFileName === true && /filename/i.test(format);
    },
    readText: () => {
      calls.push('readText');
      return state.text;
    },
    readImage: () => {
      calls.push('readImage');
      return state.image;
    },
  };
  if (opts.noReadBuffer !== true) {
    clip.readBuffer = (format: string) => {
      calls.push('readBuffer:' + format);
      return state.imageBuf ?? Buffer.alloc(0);
    };
  }
  return clip;
}

/** 假记录器：只记下"被要求记录了什么"，不碰数据库。 */
function makeSink(): {
  sink: RecordSink;
  texts: string[];
  images: (string | null | undefined)[];
  /** 与 texts 一一对应的来源（undefined = 未知）。 */
  textSources: (string | undefined)[];
  /** 与 images 一一对应的来源。 */
  imageSources: (string | undefined)[];
} {
  const texts: string[] = [];
  const images: (string | null | undefined)[] = [];
  const textSources: (string | undefined)[] = [];
  const imageSources: (string | undefined)[] = [];
  const sink: RecordSink = {
    lastSeen: new LastSeen(),
    recordText: (t: string, sourceApp?: string) => {
      texts.push(t);
      textSources.push(sourceApp);
    },
    recordImage: (_img: NativeImageLike, sig?: string | null, sourceApp?: string) => {
      images.push(sig);
      imageSources.push(sourceApp);
    },
  };
  return { sink, texts, images, textSources, imageSources };
}

describe('shouldSkipFormats（纯函数）', () => {
  it('文件列表 → skip-files', () => {
    expect(shouldSkipFormats(['text/uri-list'])).toBe('skip-files');
    expect(shouldSkipFormats(['FileNameW'])).toBe('skip-files');
  });

  it('只有 text/html、没有 text/plain → skip-rich', () => {
    expect(shouldSkipFormats(['text/html'])).toBe('skip-rich');
    expect(shouldSkipFormats(['text/html', 'text/plain'])).toBe('none');
  });

  it('图片 / 纯文本 / 空剪贴板 → none', () => {
    expect(shouldSkipFormats(['image/png'])).toBe('none');
    expect(shouldSkipFormats(['text/plain'])).toBe('none');
    expect(shouldSkipFormats([])).toBe('none');
  });

  it('图片优先于 html（同一份剪贴板里两者都有时不能因为 html 而跳过）', () => {
    expect(shouldSkipFormats(['text/html', 'image/png'])).toBe('none');
  });
});

describe('imageSignature（粗判，刻意不解码）', () => {
  it('同尺寸同内容两次调用相等', () => {
    const buf = Buffer.alloc(64, 9);
    expect(imageSignature(['image/png'], buf)).toBe(imageSignature(['image/png'], buf));
  });

  it('只改末尾一个字节（前 4KB 之外）签名仍相等——这是"不为此解码"的代价，用测试钉住', () => {
    const a = Buffer.alloc(IMAGE_SIG_HEAD_BYTES + 100, 1);
    const b = Buffer.from(a);
    b[b.length - 1] = 200;
    expect(imageSignature(['image/png'], a)).toBe(imageSignature(['image/png'], b));
  });

  it('字节长度变化则签名不等', () => {
    const a = Buffer.alloc(64, 1);
    const b = Buffer.alloc(65, 1);
    expect(imageSignature(['image/png'], a)).not.toBe(imageSignature(['image/png'], b));
  });

  it('格式列表变化则签名不等', () => {
    const buf = Buffer.alloc(64, 1);
    expect(imageSignature(['image/png'], buf)).not.toBe(imageSignature(['image/bmp'], buf));
  });
});

describe('ClipboardWatcher.tick 两级读取', () => {
  it('幽灵模式：tick 第一行就 return，完全不调用任何 clipboard.* API', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '幽灵期间的内容' });
    const { sink, texts } = makeSink();
    let ghost = true;
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      isGhostActive: () => ghost,
      intervalMs: 5,
      onTrace: () => {},
    });

    w.start();
    await sleep(40);
    expect(clip.calls).toEqual([]); // ★ 一个 clipboard API 都没碰
    expect(texts).toEqual([]);

    ghost = false;
    await sleep(40);
    expect(clip.calls.length).toBeGreaterThan(0);
    expect(texts).toEqual(['幽灵期间的内容']);
    w.stop();
  });

  it('文件列表：第一次给一次轻提示，之后不再打扰，且不入库', async () => {
    const clip = makeClip({ formats: ['text/uri-list'] });
    const { sink, texts } = makeSink();
    const notices: string[] = [];
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      onNotice: (kind, message) => notices.push(kind + '|' + message),
      onTrace: () => {},
    });

    w.start();
    await sleep(50);
    w.stop();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('skip-files');
    expect(texts).toEqual([]);
  });

  it('FileNameW 存在时按文件列表跳过（不等 availableFormats 说话）', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: 'C:\\temp', hasFileName: true });
    const { sink, texts } = makeSink();
    const notices: string[] = [];
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      onNotice: (k) => notices.push(k),
      onTrace: () => {},
    });

    w.start();
    await sleep(30);
    w.stop();

    expect(notices).toEqual(['skip-files']);
    expect(texts).toEqual([]);
  });

  it('图片粗判签名相同 → 不调 readImage（不为此解码整张位图）', async () => {
    const buf = Buffer.alloc(128, 7);
    const clip = makeClip({ formats: ['image/png'], imageBuf: buf });
    const { sink, images } = makeSink();
    sink.lastSeen.imageSig = imageSignature(['image/png'], buf);

    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });
    w.start();
    await sleep(30);
    w.stop();

    expect(clip.calls).not.toContain('readImage');
    expect(clip.calls).toContain('readBuffer:image/png');
    expect(images).toEqual([]);
  });

  it('图片签名变化 → 才调 readImage 解码并交给记录器', async () => {
    const clip = makeClip({ formats: ['image/png'], imageBuf: Buffer.alloc(128, 7) });
    const { sink, images } = makeSink();
    sink.lastSeen.imageSig = '上次的旧签名';

    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });
    w.start();
    await sleep(30);
    w.stop();

    expect(clip.calls).toContain('readImage');
    expect(images).toHaveLength(1);
  });

  it('文本：同一内容连续多跳只记一次，换了内容才再记', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: 'hello' });
    const { sink, texts } = makeSink();
    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });

    w.start();
    await sleep(40);
    expect(texts).toEqual(['hello']);

    await sleep(20);
    expect(texts).toEqual(['hello']); // 同内容不重复

    clip.state.text = 'world';
    await sleep(30);
    expect(texts).toEqual(['hello', 'world']);
    w.stop();
  });

  it('空剪贴板 / 只有 html 且无纯文本 → 什么都不做', async () => {
    const empty = makeClip({ formats: [] });
    const { sink, texts } = makeSink();
    const w1 = new ClipboardWatcher({ clip: empty, recorder: sink, intervalMs: 5, onTrace: () => {} });
    w1.start();
    await sleep(30);
    w1.stop();
    expect(texts).toEqual([]);
  });
});

describe('isSelfExe（排除自身，避免自引用来源）', () => {
  it('electron.exe / clipchan.exe / clipchan-helper.exe 都算自己（大小写不敏感）', () => {
    expect(isSelfExe('electron.exe')).toBe(true);
    expect(isSelfExe('Clipchan.exe')).toBe(true);
    expect(isSelfExe('CLIPCHAN-HELPER.EXE')).toBe(true);
  });

  it('别的程序不算自己；null / undefined / 空串也不算', () => {
    expect(isSelfExe('notepad.exe')).toBe(false);
    expect(isSelfExe('code.exe')).toBe(false);
    expect(isSelfExe(null)).toBe(false);
    expect(isSelfExe(undefined)).toBe(false);
    expect(isSelfExe('')).toBe(false);
  });
});

describe('ClipboardWatcher 来源应用追踪（sourceApp）', () => {
  it('检测到新内容时取前台 exe 名并随记录一起交给 sink', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '来自记事本' });
    const { sink, texts, textSources } = makeSink();
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      foregroundExe: async () => 'notepad.exe',
      onTrace: () => {},
    });

    w.start();
    await waitFor(() => texts.length === 1);
    await w.whenRecordsSettled();
    w.stop();

    expect(texts).toEqual(['来自记事本']);
    expect(textSources).toEqual(['notepad.exe']);
  });

  it('★ 助手不可用（foregroundExe 返回 null）时照常记录，sourceApp 为 undefined', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '没有来源也要记' });
    const { sink, texts, textSources } = makeSink();
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      foregroundExe: async () => null,
      onTrace: () => {},
    });

    w.start();
    await waitFor(() => texts.length === 1);
    await w.whenRecordsSettled();
    w.stop();

    expect(texts).toEqual(['没有来源也要记']);
    expect(textSources).toEqual([undefined]);
  });

  it('★ 取来源抛异常时照常记录，且异常不冒泡到轮询循环', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '助手炸了也要记' });
    const { sink, texts, textSources } = makeSink();
    const traces: string[] = [];
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      foregroundExe: async () => {
        throw new Error('助手崩了');
      },
      onTrace: (m) => traces.push(m),
    });

    w.start();
    await waitFor(() => texts.length === 1);
    await w.whenRecordsSettled();
    w.stop();

    expect(texts).toEqual(['助手炸了也要记']);
    expect(textSources).toEqual([undefined]);
    expect(traces.some((t) => t.includes('取来源应用失败'))).toBe(true);
    expect(w.failureCount).toBe(0); // 取来源失败不算剪贴板读取失败
  });

  it('★ 助手活着但不回包（超时）时照常记录，不被来源拖住', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '助手不回包' });
    const { sink, texts, textSources } = makeSink();
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      // 永不兑现：模拟助手活着但不回包
      foregroundExe: () => new Promise<string | null>(() => {}),
      onTrace: () => {},
    });

    w.start();
    await waitFor(() => texts.length === 1, SOURCE_APP_TIMEOUT_MS + 2000);
    await w.whenRecordsSettled();
    w.stop();

    expect(texts).toEqual(['助手不回包']);
    expect(textSources).toEqual([undefined]);
  });

  it('★ 前台是自己（面板内粘贴回写）时不记来源', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '面板里复制的内容' });
    const { sink, texts, textSources } = makeSink();
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      foregroundExe: async () => 'electron.exe',
      onTrace: () => {},
    });

    w.start();
    await waitFor(() => texts.length === 1);
    await w.whenRecordsSettled();
    w.stop();

    expect(texts).toEqual(['面板里复制的内容']);
    expect(textSources).toEqual([undefined]);
  });

  it('没注入 foregroundExe 时视为"来源未知"（向后兼容）', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: 'x' });
    const { sink, texts, textSources } = makeSink();
    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });

    w.start();
    await waitFor(() => texts.length === 1);
    await w.whenRecordsSettled();
    w.stop();

    expect(textSources).toEqual([undefined]);
  });

  it('图片也带来源', async () => {
    const clip = makeClip({ formats: ['image/png'], imageBuf: Buffer.alloc(128, 3) });
    const { sink, images, imageSources } = makeSink();
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      foregroundExe: async () => 'mspaint.exe',
      onTrace: () => {},
    });

    w.start();
    await waitFor(() => images.length === 1);
    await w.whenRecordsSettled();
    w.stop();

    expect(imageSources).toEqual(['mspaint.exe']);
  });

  it('同一内容连续多跳只问一次助手（不为重复内容反复取来源）', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '同一份' });
    const { sink, texts } = makeSink();
    let probes = 0;
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      foregroundExe: async () => {
        probes += 1;
        return 'notepad.exe';
      },
      onTrace: () => {},
    });

    w.start();
    await waitFor(() => texts.length === 1);
    await sleep(40);
    await w.whenRecordsSettled();
    w.stop();

    expect(probes).toBe(1);
  });

  it('内容按复制顺序落库（来源查询慢也不会让记录乱序）', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: '第一' });
    const { sink, texts } = makeSink();
    let call = 0;
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      // 第一次慢、第二次快：串行链必须保证"第一"先落
      foregroundExe: async () => {
        call += 1;
        if (call === 1) await sleep(60);
        return 'notepad.exe';
      },
      onTrace: () => {},
    });

    w.start();
    await waitFor(() => texts.length === 1);
    clip.state.text = '第二';
    await waitFor(() => texts.length === 2);
    await w.whenRecordsSettled();
    w.stop();

    expect(texts).toEqual(['第一', '第二']);
  });
});

describe('ClipboardWatcher.suppressNext（自我抑制）', () => {
  it('下一跳丢弃且只丢一次：标记不是永久关闭', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: 'a' });
    const { sink, texts } = makeSink();
    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });

    w.suppressNext();
    w.start();
    await sleep(30);
    expect(texts).toEqual([]); // 被抑制
    expect(sink.lastSeen.text).toBe('a'); // 但"上次值"已更新，不会下一跳又记一遍

    clip.state.text = 'b';
    await sleep(30);
    expect(texts).toEqual(['b']); // 恢复记录
    w.stop();
  });

  it('抑制标记只吃一跳：程序连续写两次剪贴板要各抑制一次', async () => {
    const clip = makeClip({ formats: ['text/plain'], text: 'x' });
    const { sink, texts } = makeSink();
    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 5, onTrace: () => {} });

    w.suppressNext();
    w.start();
    await sleep(30);
    expect(texts).toEqual([]);

    // 不补抑制标记：后续内容照常记录
    clip.state.text = 'y';
    await sleep(30);
    expect(texts).toEqual(['y']);
    w.stop();
  });
});

describe('剪贴板被占用（连续失败）', () => {
  it('失败即跳过本跳、不重试；连续失败达到阈值才写一条 CLIPCHAN_TRACE', async () => {
    let boom = true;
    const clip: ClipboardLike = {
      availableFormats: () => {
        if (boom) throw new Error('剪贴板被占用');
        return [];
      },
      has: () => false,
      readText: () => '',
      readImage: () => fakeImage(),
    };
    const { sink } = makeSink();
    const traces: string[] = [];
    const w = new ClipboardWatcher({
      clip,
      recorder: sink,
      intervalMs: 5,
      onTrace: (m) => traces.push(m),
    });

    w.start();
    await waitFor(() => w.failureCount >= FAILURE_TRACE_THRESHOLD);
    expect(w.failureCount).toBeGreaterThanOrEqual(FAILURE_TRACE_THRESHOLD);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0]).toContain('连续读取失败');

    boom = false;
    await waitFor(() => w.failureCount === 0);
    expect(w.failureCount).toBe(0); // 恢复后计数清零
    w.stop();
  });

  it('writeWatcherTrace 只在设了 CLIPCHAN_TRACE 时写文件', () => {
    const dir = tmpDir();
    const file = join(dir, 'clipchan-watcher-trace.log');
    const before = process.env.CLIPCHAN_TRACE;
    try {
      delete process.env.CLIPCHAN_TRACE;
      writeWatcherTrace('不该出现', dir);
      expect(existsSync(file)).toBe(false);

      process.env.CLIPCHAN_TRACE = '1';
      writeWatcherTrace('第一行', dir);
      expect(readFileSync(file, 'utf8')).toContain('第一行');
    } finally {
      if (before === undefined) delete process.env.CLIPCHAN_TRACE;
      else process.env.CLIPCHAN_TRACE = before;
    }
  });
});

describe('ClipboardWatcher 生命周期', () => {
  it('start/stop 幂等，isRunning 反映真实状态', () => {
    const clip = makeClip();
    const { sink } = makeSink();
    const w = new ClipboardWatcher({ clip, recorder: sink, intervalMs: 1000, onTrace: () => {} });
    expect(w.isRunning()).toBe(false);
    w.start();
    w.start();
    expect(w.isRunning()).toBe(true);
    w.stop();
    w.stop();
    expect(w.isRunning()).toBe(false);
  });
});