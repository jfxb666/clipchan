import type { OcrLang, OcrProgress, OcrResult, OcrStatus } from '../types';
import type { ToastTone } from './toastText';

/**
 * OCR 面板的纯函数与常量。与 optimizeView.ts 同一处理：
 * 仓库测试跑在 node 环境（无 jsdom），组件不可测，能测的只有纯函数。
 */

/**
 * 各语言包的体积（字节），用于「需要先下载语言包（约 X MB）」的估算。
 * ★ 实测值：jsdelivr 上 `4.0.0_best_int` 的 Content-Length。
 *   写死而不是问主进程要：未下载时磁盘上没有文件可量，而为了算一句提示
 *   多跑一次 HEAD 请求不值得（还会让未就绪的面板依赖网络）。
 */
const LANG_BYTES: Record<OcrLang, number> = {
  eng: 2952873,
  chi_sim: 1718768,
};

/** 按十进制 MB（1 MB = 10⁶ 字节）累加：两个包合计 4.7 MB，与计划里的实测数一致。 */
function missingSizeLabel(missing: OcrLang[]): string {
  let bytes = 0;
  for (const lang of missing) bytes += LANG_BYTES[lang] ?? 0;
  const mb = Math.round((bytes / 1e6) * 10) / 10;
  return mb.toFixed(1) + ' MB';
}

/**
 * 就绪状态 → 一句中文。
 * ★ error 优先：上次下载/识别失败的原因比「需要下载」更有信息量，
 *   否则用户只会反复点下载而看不到为什么失败。
 */
export function ocrStatusText(s: OcrStatus): string {
  const error = s.error?.trim() ?? '';
  if (error !== '') return error;
  if (s.ready) return '文字识别已就绪';
  if (s.missing.length > 0) return '需要先下载语言包（约 ' + missingSizeLabel(s.missing) + '）';
  // 既没就绪也没报缺包（主进程状态不一致）：不返回空串，否则面板上是一片空白。
  return '文字识别未就绪';
}

const OCR_FAILED_TEXT = '文字识别失败，请重试';

/** 失败原因：Error / 字符串取原文；其它类型不把 undefined 摊给用户。 */
export function ocrErrorText(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.trim();
    return message === '' ? OCR_FAILED_TEXT : message;
  }
  if (typeof err === 'string') {
    const message = err.trim();
    return message === '' ? OCR_FAILED_TEXT : message;
  }
  return OCR_FAILED_TEXT;
}

/**
 * 能否「存为一条新记录」。
 * ★ 全空白（tesseract 对纯图片常回空白串）存进去就是一条空记录，
 *   与其让用户存完发现是空的，不如按钮直接禁用。
 */
export function canSaveAsItem(r: OcrResult): boolean {
  return r.text.trim() !== '';
}

export const OCR_SAVED_TOAST = '已存为一条记录';
/** 没识别到文字不是失败（图里本来就可能没字），所以是 warn 而不是 error。 */
export const OCR_EMPTY_TOAST = '没有识别到文字';

export function ocrSavedToast(): { text: string; tone: ToastTone } {
  return { text: OCR_SAVED_TOAST, tone: 'ok' };
}

export function ocrEmptyToast(): { text: string; tone: ToastTone } {
  return { text: OCR_EMPTY_TOAST, tone: 'warn' };
}

/** 进度 → 一句中文。下载比例未知（-1）时不写百分比，免得显示「正在下载 -100%」。 */
export function ocrProgressText(p: OcrProgress): string {
  if (p.phase === 'recognize') return '正在识别…';
  if (p.ratio < 0) return '正在下载…';
  return '正在下载 ' + Math.round(p.ratio * 100) + '%';
}
