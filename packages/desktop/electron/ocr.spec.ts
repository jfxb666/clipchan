/**
 * OCR 引擎的用例（计划 §3 T4 验收）。
 *
 * ★ 全程不联网、不碰真实文件系统：网络 / 磁盘 / worker 全部从 OcrDeps 注入替身。
 *   任何一条用例跑起来都不该出现 fetch，也不该在临时目录里留下文件。
 */
import { describe, expect, it } from 'vitest';
import type { OcrLang, OcrProgress } from '@clipchan/core';
import {
  LANG_BYTES,
  LANG_SHA256,
  LANG_URL,
  OCR_LANGS,
  OCR_NOT_READY,
  OcrHttpError,
  createOcr,
  langFile,
} from './ocr';
import type { OcrDeps, OcrWorkerLike } from './ocr';

const LANG_DIR = 'C:\\fake\\data\\ocr';
const CORE_PATH = 'C:\\fake\\node_modules\\tesseract.js-core';

/** 内存文件系统：key 是注入层看到的绝对路径。 */
function fakeFs(seed: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  return {
    files,
    exists: (p: string): boolean => files.has(p),
    readFile: (p: string): Uint8Array => {
      const b = files.get(p);
      if (!b) throw new Error('ENOENT: ' + p);
      return b;
    },
    writeFile: (p: string, b: Uint8Array): void => {
      files.set(p, b);
    },
  };
}

/** 假 worker：记调用次数，回一段带首尾空白的文本（用例要验 trim）。 */
function fakeWorker(opts: { text?: string; confidence?: number; ms?: number } = {}) {
  const worker = {
    calls: 0,
    terminated: 0,
    lastImage: '',
    async recognize(image: string): Promise<{ data: { text?: string; confidence?: number; ms?: number } }> {
      worker.calls += 1;
      worker.lastImage = image;
      return { data: { text: opts.text ?? '  hello 世界 \n', confidence: opts.confidence ?? 87, ms: opts.ms ?? 12 } };
    },
    async terminate(): Promise<unknown> {
      worker.terminated += 1;
      return null;
    },
  };
  return worker;
}

/** 只造缺的那两个语言包的「正确字节」：sha256 替身按内容查表。 */
function fakeSha(known: Record<string, string> = LANG_SHA256) {
  return (b: Uint8Array): string => {
    const text = Buffer.from(b).toString('utf8');
    return known[text] ?? 'deadbeef';
  };
}

const engBytes = (): Uint8Array => Buffer.from('eng', 'utf8');
const chiBytes = (): Uint8Array => Buffer.from('chi_sim', 'utf8');

/** 假 fetchBytes：按 URL 里的语言名回对应字节。 */
function fakeFetch(map: Record<string, Uint8Array | Error> = {}) {
  const urls: string[] = [];
  const fn = async (url: string): Promise<Uint8Array> => {
    urls.push(url);
    const lang = url.includes('chi_sim') ? 'chi_sim' : 'eng';
    const hit = map[lang] ?? (lang === 'chi_sim' ? chiBytes() : engBytes());
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return { fn, urls };
}

function deps(over: Partial<OcrDeps> & { fs?: ReturnType<typeof fakeFs> } = {}): OcrDeps & { fs: ReturnType<typeof fakeFs> } {
  const f = over.fs ?? fakeFs();
  const { fs: _drop, ...rest } = over;
  return {
    langDir: LANG_DIR,
    corePath: CORE_PATH,
    exists: f.exists,
    readFile: f.readFile,
    writeFile: f.writeFile,
    mkdirp: () => undefined,
    ...rest,
    fs: f,
  };
}

describe('OCR 常量', () => {
  it('语言固定 eng + chi_sim，URL 与文件名都带语言名', () => {
    expect([...OCR_LANGS]).toEqual(['eng', 'chi_sim']);
    expect(LANG_URL('eng')).toBe(
      'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
    );
    expect(LANG_URL('chi_sim')).toContain('/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz');
    expect(langFile('eng')).toBe('eng.traineddata.gz');
  });

  it('两条 SHA-256 都是 64 位小写 hex（防手抄错）', () => {
    for (const lang of OCR_LANGS) {
      const v = LANG_SHA256[lang];
      expect(v).toMatch(/^[0-9a-f]{64}$/);
      expect(v).toHaveLength(64);
    }
  });

  it('体积表两条都是正数（进度条要用来估总量）', () => {
    for (const lang of OCR_LANGS) expect(LANG_BYTES[lang]).toBeGreaterThan(0);
  });
});

describe('status', () => {
  it('两个语言包都在 → ready', async () => {
    const f = fakeFs({
      [LANG_DIR + '\\eng.traineddata.gz']: engBytes(),
      [LANG_DIR + '\\chi_sim.traineddata.gz']: chiBytes(),
    });
    const ocr = createOcr(deps({ fs: f }));
    const st = await ocr.status();
    expect(st.ready).toBe(true);
    expect(st.missing).toEqual([]);
    expect(st.languages).toEqual(['eng', 'chi_sim']);
    expect(st.error).toBeUndefined();
  });

  it('缺 chi_sim → missing 只含 chi_sim，ready:false', async () => {
    const f = fakeFs({ [LANG_DIR + '\\eng.traineddata.gz']: engBytes() });
    const ocr = createOcr(deps({ fs: f }));
    const st = await ocr.status();
    expect(st.ready).toBe(false);
    expect(st.missing).toEqual(['chi_sim']);
    expect(st.languages).toEqual(['eng']);
  });

  it('都缺 → missing 两个，ready:false', async () => {
    const ocr = createOcr(deps());
    const st = await ocr.status();
    expect(st.ready).toBe(false);
    expect(st.missing).toEqual(['eng', 'chi_sim']);
    expect(st.languages).toEqual([]);
  });
});

describe('download', () => {
  it('成功路径：校验通过 → 两个文件都落盘 → 再次 status 变 ready', async () => {
    const f = fakeFs();
    const fetch = fakeFetch();
    const progress: OcrProgress[] = [];
    const ocr = createOcr(
      deps({ fs: f, fetchBytes: fetch.fn, sha256: fakeSha(), onProgress: (p) => progress.push(p) }),
    );

    const st = await ocr.download();
    expect(st.ready).toBe(true);
    expect(st.missing).toEqual([]);
    expect(st.error).toBeUndefined();
    expect(f.files.has(LANG_DIR + '\\eng.traineddata.gz')).toBe(true);
    expect(f.files.has(LANG_DIR + '\\chi_sim.traineddata.gz')).toBe(true);
    expect(fetch.urls).toEqual([LANG_URL('eng'), LANG_URL('chi_sim')]);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.phase === 'download')).toBe(true);
    // 最后一条进度必须是 1：两条都下完就是满格。
    expect(progress[progress.length - 1]!.ratio).toBeCloseTo(1, 10);

    const again = await ocr.status();
    expect(again.ready).toBe(true);
  });

  it('只缺一个时只下这一个（不重下已就绪的）', async () => {
    const f = fakeFs({ [LANG_DIR + '\\eng.traineddata.gz']: engBytes() });
    const fetch = fakeFetch();
    const ocr = createOcr(deps({ fs: f, fetchBytes: fetch.fn, sha256: fakeSha() }));
    const st = await ocr.download();
    expect(st.ready).toBe(true);
    expect(fetch.urls).toEqual([LANG_URL('chi_sim')]);
  });

  it('校验失败：不落盘 + 中文 error 含语言名 + ready:false', async () => {
    const f = fakeFs();
    const fetch = fakeFetch();
    // 无论内容是什么都回一个错值，逼出校验失败分支。
    const ocr = createOcr(deps({ fs: f, fetchBytes: fetch.fn, sha256: () => '0'.repeat(64) }));
    const st = await ocr.download();
    expect(st.ready).toBe(false);
    expect(st.error).toContain('校验失败');
    expect(st.error).toContain('eng');
    // ★ 一个字节都不许落盘：半个语言包比没有更糟。
    expect(f.files.size).toBe(0);
    expect(st.missing).toEqual(['eng', 'chi_sim']);
  });

  it('网络失败：中文 error 含「下载失败」+ 原因', async () => {
    const f = fakeFs();
    const fetch = fakeFetch({ eng: new Error('网络不可达') });
    const ocr = createOcr(deps({ fs: f, fetchBytes: fetch.fn, sha256: fakeSha() }));
    const st = await ocr.download();
    expect(st.ready).toBe(false);
    expect(st.error).toContain('下载失败');
    expect(st.error).toContain('网络不可达');
    expect(f.files.size).toBe(0);
  });

  it('HTTP 非 2xx：error 里带状态码（与网络异常分开写）', async () => {
    const f = fakeFs();
    const fetch = fakeFetch({ eng: new OcrHttpError(503) });
    const ocr = createOcr(deps({ fs: f, fetchBytes: fetch.fn, sha256: fakeSha() }));
    const st = await ocr.download();
    expect(st.error).toBe('下载失败（eng）：HTTP 503');
    expect(f.files.size).toBe(0);
  });

  it('error 只保留到下一次成功为止（成功后清空）', async () => {
    const f = fakeFs();
    const bad = fakeFetch({ eng: new Error('网络不可达') });
    const ocr = createOcr(deps({ fs: f, fetchBytes: bad.fn, sha256: fakeSha() }));
    const failed = await ocr.download();
    expect(failed.error).toBeTruthy();
    // 换成能通的下载器，重下同一份目录。
    const ok = fakeFetch();
    const ocr2 = createOcr(deps({ fs: f, fetchBytes: ok.fn, sha256: fakeSha() }));
    const done = await ocr2.download();
    expect(done.error).toBeUndefined();
    expect(done.ready).toBe(true);
  });
});

describe('recognize', () => {
  it('未就绪 → 抛「尚未下载文字识别语言包」', async () => {
    const ocr = createOcr(deps());
    await expect(ocr.recognize('C:\\fake\\a.png')).rejects.toThrow(OCR_NOT_READY);
  });

  it('成功 → 文本被 trim、confidence/ms 透传，且第二次不再建 worker', async () => {
    const f = fakeFs({
      [LANG_DIR + '\\eng.traineddata.gz']: engBytes(),
      [LANG_DIR + '\\chi_sim.traineddata.gz']: chiBytes(),
    });
    const worker = fakeWorker({ text: '  你好 world  \n', confidence: 91, ms: 42 });
    let created = 0;
    let seenLangs: string[] = [];
    let seenOpts: Record<string, unknown> = {};
    const ocr = createOcr(
      deps({
        fs: f,
        createWorker: async (langs, oem, opts) => {
          created += 1;
          seenLangs = langs;
          seenOpts = opts;
          return worker as OcrWorkerLike;
        },
      }),
    );

    const r1 = await ocr.recognize('C:\\fake\\a.png');
    expect(r1).toEqual({ text: '你好 world', confidence: 91, ms: 42 });
    expect(created).toBe(1);
    expect(seenLangs).toEqual(['eng', 'chi_sim']);
    expect(seenOpts.langPath).toBe(LANG_DIR);
    expect(seenOpts.cachePath).toBe(LANG_DIR);
    expect(seenOpts.corePath).toBe(CORE_PATH);
    expect(seenOpts.gzip).toBe(true);
    expect(worker.lastImage).toBe('C:\\fake\\a.png');

    const r2 = await ocr.recognize('C:\\fake\\b.png');
    expect(r2.text).toBe('你好 world');
    // ★ 复用同一个 worker：再建一次就是 300–450ms 白等。
    expect(created).toBe(1);
    expect(worker.calls).toBe(2);
    expect(worker.lastImage).toBe('C:\\fake\\b.png');
  });

  it('worker 不自带 ms 时自己量（真实 Page 没有 ms）', async () => {
    const f = fakeFs({
      [LANG_DIR + '\\eng.traineddata.gz']: engBytes(),
      [LANG_DIR + '\\chi_sim.traineddata.gz']: chiBytes(),
    });
    const worker = {
      calls: 0,
      async recognize(): Promise<{ data: { text?: string; confidence?: number } }> {
        worker.calls += 1;
        return { data: { text: 'abc', confidence: 50 } };
      },
      async terminate(): Promise<unknown> {
        return null;
      },
    };
    const ocr = createOcr(deps({ fs: f, createWorker: async () => worker }));
    const r = await ocr.recognize('C:\\fake\\a.png');
    expect(r.text).toBe('abc');
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('建 worker 失败不缓存：下一次还能重试', async () => {
    const f = fakeFs({
      [LANG_DIR + '\\eng.traineddata.gz']: engBytes(),
      [LANG_DIR + '\\chi_sim.traineddata.gz']: chiBytes(),
    });
    const worker = fakeWorker();
    let created = 0;
    const ocr = createOcr(
      deps({
        fs: f,
        createWorker: async () => {
          created += 1;
          if (created === 1) throw new Error('wasm 初始化失败');
          return worker as OcrWorkerLike;
        },
      }),
    );
    await expect(ocr.recognize('C:\\fake\\a.png')).rejects.toThrow('wasm 初始化失败');
    const ok = await ocr.recognize('C:\\fake\\a.png');
    expect(ok.text).toBe('hello 世界');
    expect(created).toBe(2);
  });
});

describe('dispose', () => {
  it('没建过 worker 时是 no-op', async () => {
    const ocr = createOcr(deps());
    await expect(ocr.dispose()).resolves.toBeUndefined();
  });

  it('建过就 terminate，且只 terminate 一次', async () => {
    const f = fakeFs({
      [LANG_DIR + '\\eng.traineddata.gz']: engBytes(),
      [LANG_DIR + '\\chi_sim.traineddata.gz']: chiBytes(),
    });
    const worker = fakeWorker();
    const ocr = createOcr(deps({ fs: f, createWorker: async () => worker as OcrWorkerLike }));
    await ocr.recognize('C:\\fake\\a.png');
    await ocr.dispose();
    expect(worker.terminated).toBe(1);
    await ocr.dispose();
    expect(worker.terminated).toBe(1);
  });
});

describe('语言包文件名与 OcrLang 对齐', () => {
  it('每个 OcrLang 都有 SHA/体积/文件名三条常量', () => {
    for (const lang of OCR_LANGS as readonly OcrLang[]) {
      expect(LANG_SHA256[lang]).toBeTruthy();
      expect(LANG_BYTES[lang]).toBeTruthy();
      expect(langFile(lang)).toBe(lang + '.traineddata.gz');
    }
  });
});
