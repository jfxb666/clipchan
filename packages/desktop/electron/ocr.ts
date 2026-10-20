/**
 * OCR 引擎（v0.5.0 T4，计划 §3 T4）。
 *
 * ★ 铁律三：tesseract.js 是 CommonJS + worker_threads + WASM，渲染进程跑不了，
 *   所以 require 与 wasm 路径全部留在主进程，渲染层只通过 ClipchanApi.ocr 拿文本。
 * ★ 依赖注入（与 ai.ts 同风格）：顶层不 import electron、不 import tesseract.js，
 *   网络与文件 IO 全部从 OcrDeps 进来 —— ocr.spec.ts 才能在完全离线的情况下跑。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OcrLang, OcrProgress, OcrResult, OcrStatus } from '@clipchan/core';

/** 语言固定这两个（Ruling 2：不做语言选择 UI）。 */
export const OCR_LANGS = ['eng', 'chi_sim'] as const;

/**
 * 语言包地址（Ruling 3 钉死 jsdelivr）。
 * ★ 不要退回 tesseract 的默认源 tessdata.projectnaptha.com：本机实测直连超时。
 */
export const LANG_URL = (lang: string): string =>
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/' + lang + '/4.0.0_best_int/' + lang + '.traineddata.gz';

/** 已实测的 SHA-256；对不上就拒绝落盘（坏语言包会让 tesseract 在初始化时报别处的错）。 */
export const LANG_SHA256: Record<OcrLang, string> = {
  eng: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  chi_sim: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c',
};

/** 语言包体积（字节）：只用来估下载进度条的总量，不参与校验。 */
export const LANG_BYTES: Record<OcrLang, number> = { eng: 2952873, chi_sim: 1718768 };

/** 没就绪时的中文原因：渲染层按这句话决定要不要弹「先下载语言包」。 */
export const OCR_NOT_READY = '尚未下载文字识别语言包';

/** 语言包文件名；.gz 后缀必须留着，worker 靠它决定要不要解压（配 gzip:true）。 */
export const langFile = (lang: string): string => lang + '.traineddata.gz';

/**
 * HTTP 非 2xx 单独一个类型。
 * ★ 只有分得出「服务器回了 500」和「根本连不上」，才能给用户两句不同的中文原因。
 */
export class OcrHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('HTTP ' + status);
    this.name = 'OcrHttpError';
    this.status = status;
  }
}

/** tesseract worker 的最小形状：只声明用到的两个方法，避免把它的 .d.ts 拉进主进程。 */
export interface OcrWorkerLike {
  recognize(image: string): Promise<{ data: OcrPageLike }>;
  terminate(): Promise<unknown>;
}

/** tesseract 结果页里我们真正读的字段（其余字段一律不碰）。 */
export interface OcrPageLike {
  text?: string;
  confidence?: number;
  /** 真实 Page 没有这个字段（实测），留着给替身/未来版本自己报耗时。 */
  ms?: number;
}

export interface OcrDeps {
  /** <dataDir>/ocr：语言包与 worker 缓存都放这（随数据目录走，卸载重装不丢）。 */
  langDir: string;
  /** tesseract.js-core 目录（打包后是 unpacked 路径，wasm 不能从 asar 里读）。 */
  corePath: string;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  createWorker?: (langs: string[], oem: number, opts: Record<string, unknown>) => Promise<OcrWorkerLike>;
  onProgress?: (p: OcrProgress) => void;
  readFile?: (p: string) => Uint8Array;
  writeFile?: (p: string, b: Uint8Array) => void;
  exists?: (p: string) => boolean;
  sha256?: (b: Uint8Array) => string;
  mkdirp?: (p: string) => void;
}

export interface OcrApi {
  status(): Promise<OcrStatus>;
  download(): Promise<OcrStatus>;
  recognize(imagePath: string): Promise<OcrResult>;
  dispose(): Promise<void>;
}

/** 失败原因统一成一句可读文本；非 Error 也要有字（绝不回 undefined 假装成功）。 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && e.message !== '') return e.message;
  return String(e);
}

/** 默认下载：非 2xx 必须抛错，否则会把一段错误页当成语言包写进磁盘。 */
async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new OcrHttpError(res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** 默认建 worker：延迟 require，主进程启动时不必为 OCR 付加载成本。 */
function defaultCreateWorker(
  langs: string[],
  oem: number,
  opts: Record<string, unknown>,
): Promise<OcrWorkerLike> {
  // ★ 非字面量 require：esbuild 见字面量会把 tesseract.js 内联进主进程 bundle，
  //   而它要靠自身所在目录定位 worker 脚本与 wasm，内联后路径全错。
  const id = 'tesseract.js';
  const mod = require(id) as { createWorker: OcrDeps['createWorker'] };
  return mod.createWorker!(langs, oem, opts);
}

/**
 * 造 OCR 面（status / download / recognize / dispose）。
 * @param deps 依赖注入；main.ts 传 { langDir, corePath, onProgress }。
 */
export function createOcr(deps: OcrDeps): OcrApi {
  const { langDir, corePath, onProgress } = deps;
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p));
  const writeFile =
    deps.writeFile ??
    ((p: string, b: Uint8Array) => {
      fs.writeFileSync(p, b);
    });
  const sha256 = deps.sha256 ?? ((b: Uint8Array) => createHash('sha256').update(b).digest('hex'));
  const mkdirp =
    deps.mkdirp ??
    ((p: string) => {
      fs.mkdirSync(p, { recursive: true });
    });
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const createWorker = deps.createWorker ?? defaultCreateWorker;

  /** 上次失败的中文原因；成功后清空（界面据此决定还显不显示红字）。 */
  let lastError: string | undefined;
  /** 懒创建的 worker：OCR 是重活，只有真要识别时才起线程。 */
  let workerPromise: Promise<OcrWorkerLike> | null = null;

  const filePath = (lang: OcrLang): string => path.join(langDir, langFile(lang));

  const emit = (p: OcrProgress): void => {
    if (onProgress) onProgress(p);
  };

  const missingLangs = (): OcrLang[] => OCR_LANGS.filter((l) => !exists(filePath(l)));

  const statusNow = async (): Promise<OcrStatus> => {
    const missing = missingLangs();
    const languages = OCR_LANGS.filter((l) => !missing.includes(l));
    const st: OcrStatus = { ready: missing.length === 0, languages, missing };
    if (lastError !== undefined) st.error = lastError;
    return st;
  };

  const ensureWorker = (): Promise<OcrWorkerLike> => {
    if (workerPromise) return workerPromise;
    const p = createWorker([...OCR_LANGS], 1, {
      langPath: langDir,
      cachePath: langDir,
      corePath,
      // ★ gzip:true 配 .traineddata.gz 文件名（实测可用）。
      gzip: true,
      logger: (m: { status?: string; progress?: number }) => {
        emit({
          phase: 'recognize',
          ratio: typeof m.progress === 'number' ? m.progress : -1,
          message: typeof m.status === 'string' ? m.status : '',
        });
      },
    }).catch((e: unknown) => {
      // 建 worker 失败不能缓存下来：下一次点「识别」要能重试。
      workerPromise = null;
      throw e;
    });
    workerPromise = p;
    return p;
  };

  return {
    status: () => statusNow(),

    download: async () => {
      const missing = missingLangs();
      if (missing.length === 0) {
        lastError = undefined;
        return statusNow();
      }
      try {
        mkdirp(langDir);
      } catch (e) {
        lastError = '创建语言包目录失败：' + reasonOf(e);
        return statusNow();
      }
      // 进度按已下字节估总量：LANG_BYTES 是实测体积，只用来算比例。
      const total = missing.reduce((n, l) => n + LANG_BYTES[l], 0);
      let done = 0;
      for (const lang of missing) {
        emit({
          phase: 'download',
          ratio: total > 0 ? done / total : -1,
          message: '正在下载 ' + lang + ' 语言包…',
        });
        let bytes: Uint8Array;
        try {
          bytes = await fetchBytes(LANG_URL(lang));
        } catch (e) {
          // ★ 三类失败分开写：用户能据此判断是「没网」「服务器坏了」还是「文件被换过」。
          lastError =
            e instanceof OcrHttpError
              ? '下载失败（' + lang + '）：HTTP ' + e.status
              : '下载失败（' + lang + '）：' + reasonOf(e);
          return statusNow();
        }
        if (sha256(bytes) !== LANG_SHA256[lang]) {
          // ★ 校验不过绝不落盘：半个语言包比没有更糟（tesseract 会在初始化阶段报别处的错）。
          lastError = '语言包校验失败（' + lang + '）';
          return statusNow();
        }
        try {
          writeFile(filePath(lang), bytes);
        } catch (e) {
          lastError = '写入语言包失败（' + lang + '）：' + reasonOf(e);
          return statusNow();
        }
        let wrote = 0;
        try {
          wrote = readFile(filePath(lang)).length;
        } catch {
          wrote = 0;
        }
        // 写完读回确认真的落了盘：空文件等于没下（不假装成功）。
        if (wrote === 0) {
          lastError = '写入语言包失败（' + lang + '）：文件为空';
          return statusNow();
        }
        done += LANG_BYTES[lang];
        emit({
          phase: 'download',
          ratio: total > 0 ? done / total : -1,
          message: '已下载 ' + lang + ' 语言包',
        });
      }
      lastError = undefined;
      return statusNow();
    },

    recognize: async (imagePath: string) => {
      const st = await statusNow();
      if (!st.ready) throw new Error(OCR_NOT_READY);
      const worker = await ensureWorker();
      const started = Date.now();
      const res = await worker.recognize(imagePath);
      const data: OcrPageLike = res?.data ?? {};
      // 真实 Page 没有 ms（实测），所以默认自己量；worker 自带就用它的，省得两处耗时对不上。
      const ms = typeof data.ms === 'number' && Number.isFinite(data.ms) ? data.ms : Date.now() - started;
      return {
        text: typeof data.text === 'string' ? data.text.trim() : '',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        ms,
      };
    },

    dispose: async () => {
      const pending = workerPromise;
      workerPromise = null;
      if (!pending) return;
      // 建到一半就失败的话没有 worker 可 terminate，静默跳过（dispose 不该再抛）。
      const worker = await pending.catch(() => null);
      if (worker) await worker.terminate();
    },
  };
}
