/**
 * OCR 引擎（v0.5.0 T4，计划 §3 T4）。
 *
 * ★ 铁律三：tesseract.js 是 CommonJS + worker_threads + WASM，渲染进程跑不了，
 *   所以 require 与 wasm 路径全部留在主进程，渲染层只通过 ClipchanApi.ocr 拿文本。
 * ★ 依赖注入（与 ai.ts 同风格）：顶层不 import electron、不 import tesseract.js，
 *   网络与文件 IO 全部从 OcrDeps 进来 —— ocr.spec.ts 才能在完全离线的情况下跑。
 *
 * ★ v0.5.0 收尾 §1：识别改成「放大 → PSM 6 → 文本清理」三段。
 *   实测（641×99 中文截图，CER 越低越好）：原图 + 默认 PSM 3 = 0.962，
 *   原图 + PSM 6 = 0.446，4× 放大 + PSM 6 = 0.223。灰度 / Otsu / 反色都实测有害，一律不做。
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
 * 单块文本模式（PSM 6）。
 * ★ 实测（641×99 中文截图）：默认 PSM 3 = 全自动分页，对「整块文字」的截图完全失效，
 *   CER 0.962；换 PSM 6 后降到 0.446 —— 这是本次修质量的主因，不是分辨率。
 */
export const PSM_SINGLE_BLOCK = '6';

/** 放大倍数。实测 4× 最优（CER 0.446 → 0.223），2× / 3× 都不如它。 */
export const UPSCALE_FACTOR = 4;

/**
 * 放大后短边的上限（px）。
 * ★ 4× 是固定倍数，本来就大的图再乘 4 会到 3200+，tesseract 耗时会明显上升而质量不涨，
 *   所以到顶就只放大到这条线（也保证永远不会缩小原图）。
 */
export const MAX_UPSCALED_SHORT_EDGE = 2000;

/** CJK 字符（含中文标点与全角符号）；只用来判断「空格夹在两个 CJK 之间」。 */
const CJK = '[\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]';

/**
 * 两个 CJK 字符之间的空白。
 * ★ 为什么用 lookaround 而不是捕获组：中英混排（`v0.5.0 的端到端`）里那个空格必须留着，
 *   只有「左邻右舍都是汉字」的空格才是 tesseract 硬插进来的。
 */
const CJK_GAP = new RegExp('(?<=' + CJK + ')[ \\t]+(?=' + CJK + ')', 'g');

/**
 * 按固定倍数算放大后的尺寸；短边到顶就按上限缩放，且绝不小于 1×（不缩小原图）。
 * @param width 原图宽（px）
 * @param height 原图高（px）
 */
export function upscaleSize(width: number, height: number): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  if (w === 0 || h === 0) return { width: 0, height: 0 };
  const shortEdge = Math.min(w, h);
  // 两个上界取小：倍数上限 4×，以及短边不超过 MAX_UPSCALED_SHORT_EDGE。
  const scale = Math.max(1, Math.min(UPSCALE_FACTOR, MAX_UPSCALED_SHORT_EDGE / shortEdge));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * tesseract 输出的收尾清理。
 * ★ 实测对 CER 无影响（0.223 → 0.223），但中文结果会被拆成「出 在 做 的 事」，
 *   人眼几乎没法读，所以这一段是为了可读性，不是为了准确率。
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(CJK_GAP, '')
    // 连续 3 个以上换行合并成 2 个：留一个空行分段，再多就是噪声。
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

/** tesseract worker 的最小形状：只声明用到的方法，避免把它的 .d.ts 拉进主进程。 */
export interface OcrWorkerLike {
  /** 收路径（旧行为）或图片字节（v0.5.0 起走预处理后的字节）。 */
  recognize(image: string | Uint8Array): Promise<{ data: OcrPageLike }>;
  terminate(): Promise<unknown>;
  /**
   * 可选：真 worker 有，既有 spec 的替身没有 —— 声明成可选，替身才不会全红。
   * 只用来设 PSM，见 PSM_SINGLE_BLOCK。
   */
  setParameters?: (params: Record<string, string>) => Promise<unknown>;
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
  /**
   * 识别前的图片预处理（放大）。
   * ★ 为什么走注入而不是直接在这里 import electron：本文件顶层不许 import electron
   *   （ocr.spec.ts 要在没有 electron 运行时的环境里跑），nativeImage 只能由 main.ts 递进来。
   * 返回 null 表示「这张图解不了」，调用方退回把原路径交给 tesseract。
   */
  prepare?: (imagePath: string) => { data: Uint8Array } | null;
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
  // 没注入预处理就原样把路径交给 tesseract（v0.5.0 之前的行为，spec 靠它跑）。
  const prepare = deps.prepare;

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

  /**
   * 把图片变成 tesseract 能吃的入参。
   * ★ 预处理失败不能拖垮识别：放大只是提质手段，退回原路径至少还能出字。
   */
  const prepareImage = (imagePath: string): string | Uint8Array => {
    if (!prepare) return imagePath;
    try {
      return prepare(imagePath)?.data ?? imagePath;
    } catch {
      return imagePath;
    }
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
    })
      .then(async (worker) => {
        // ★ PSM 必须用 setParameters 落到 worker 全局态：recognize 的 options 是
        //   SaveParameters/RestoreParameters 包起来的，传进去只对那一次生效。
        //   放在建 worker 的 promise 链里，天然只设一次，且失败的 promise 不会被缓存。
        if (worker.setParameters) {
          await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_BLOCK });
        }
        return worker;
      })
      .catch((e: unknown) => {
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
      const res = await worker.recognize(prepareImage(imagePath));
      const data: OcrPageLike = res?.data ?? {};
      // 真实 Page 没有 ms（实测），所以默认自己量；worker 自带就用它的，省得两处耗时对不上。
      const ms = typeof data.ms === 'number' && Number.isFinite(data.ms) ? data.ms : Date.now() - started;
      return {
        // ★ 不能只 trim：tesseract 的中文输出会在每个汉字之间插空格，见 cleanText。
        text: typeof data.text === 'string' ? cleanText(data.text) : '',
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
