import { describe, expect, it } from 'vitest';
import type { OcrProgress, OcrStatus } from '../types';
import {
  OCR_EMPTY_TOAST,
  OCR_SAVED_TOAST,
  canSaveAsItem,
  ocrEmptyToast,
  ocrErrorText,
  ocrProgressText,
  ocrSavedToast,
  ocrStatusText,
} from './ocrView';

const statusOf = (patch: Partial<OcrStatus>): OcrStatus => ({
  ready: false,
  languages: ['eng', 'chi_sim'],
  missing: [],
  ...patch,
});

describe('ocrStatusText', () => {
  it('两个语言包都在 → 已就绪', () => {
    expect(ocrStatusText(statusOf({ ready: true }))).toBe('文字识别已就绪');
  });

  it('缺两个 → 体积按 missing 累加（4.7 MB）', () => {
    expect(ocrStatusText(statusOf({ missing: ['eng', 'chi_sim'] }))).toBe('需要先下载语言包（约 4.7 MB）');
  });

  it('只缺 eng → 只算 eng 的体积（3.0 MB）', () => {
    expect(ocrStatusText(statusOf({ missing: ['eng'] }))).toBe('需要先下载语言包（约 3.0 MB）');
  });

  it('只缺 chi_sim → 只算 chi_sim 的体积（1.7 MB）', () => {
    expect(ocrStatusText(statusOf({ missing: ['chi_sim'] }))).toBe('需要先下载语言包（约 1.7 MB）');
  });

  it('有 error 时优先显示 error（即使已就绪）', () => {
    expect(ocrStatusText(statusOf({ ready: true, error: '语言包校验失败（eng）' }))).toBe('语言包校验失败（eng）');
    expect(ocrStatusText(statusOf({ missing: ['eng'], error: '下载超时' }))).toBe('下载超时');
  });

  it('error 是空白串时不算 error', () => {
    expect(ocrStatusText(statusOf({ ready: true, error: '   ' }))).toBe('文字识别已就绪');
  });

  it('既没就绪也没缺包（脏状态）→ 不返回空串', () => {
    expect(ocrStatusText(statusOf({}))).toBe('文字识别未就绪');
  });
});

describe('ocrErrorText', () => {
  it('Error 取原文', () => {
    expect(ocrErrorText(new Error('尚未下载文字识别语言包'))).toBe('尚未下载文字识别语言包');
  });

  it('字符串取原文（去掉首尾空白）', () => {
    expect(ocrErrorText('  识别超时  ')).toBe('识别超时');
  });

  it('空 Error / 空串 / 其它类型 → 兜底中文', () => {
    expect(ocrErrorText(new Error('   '))).toBe('文字识别失败，请重试');
    expect(ocrErrorText('')).toBe('文字识别失败，请重试');
    expect(ocrErrorText(undefined)).toBe('文字识别失败，请重试');
    expect(ocrErrorText(null)).toBe('文字识别失败，请重试');
    expect(ocrErrorText({ code: 1 })).toBe('文字识别失败，请重试');
  });
});

describe('canSaveAsItem', () => {
  it('有非空白文字 → 可以存', () => {
    expect(canSaveAsItem({ text: ' hello ', confidence: 90, ms: 12 })).toBe(true);
  });

  it('全空白 / 空串 → 不能存', () => {
    expect(canSaveAsItem({ text: '   ', confidence: 0, ms: 12 })).toBe(false);
    expect(canSaveAsItem({ text: '', confidence: 0, ms: 12 })).toBe(false);
    expect(canSaveAsItem({ text: '\n\t', confidence: 0, ms: 12 })).toBe(false);
  });
});

describe('toast 文案', () => {
  it('存为记录的固定文案与色调', () => {
    expect(OCR_SAVED_TOAST).toBe('已存为一条记录');
    expect(ocrSavedToast()).toEqual({ text: OCR_SAVED_TOAST, tone: 'ok' });
  });

  it('没识别到文字用 warn 而不是 error（不算失败）', () => {
    expect(OCR_EMPTY_TOAST).toBe('没有识别到文字');
    expect(ocrEmptyToast()).toEqual({ text: OCR_EMPTY_TOAST, tone: 'warn' });
  });
});

describe('ocrProgressText', () => {
  const progress = (patch: Partial<OcrProgress>): OcrProgress => ({
    phase: 'download',
    ratio: -1,
    message: '',
    ...patch,
  });

  it('下载中有比例 → 百分比', () => {
    expect(ocrProgressText(progress({ ratio: 0.42 }))).toBe('正在下载 42%');
    expect(ocrProgressText(progress({ ratio: 0 }))).toBe('正在下载 0%');
    expect(ocrProgressText(progress({ ratio: 1 }))).toBe('正在下载 100%');
  });

  it('下载比例未知（-1）→ 只写「正在下载…」', () => {
    expect(ocrProgressText(progress({ ratio: -1 }))).toBe('正在下载…');
  });

  it('识别阶段不看比例', () => {
    expect(ocrProgressText(progress({ phase: 'recognize', ratio: 0.5 }))).toBe('正在识别…');
    expect(ocrProgressText(progress({ phase: 'recognize', ratio: -1 }))).toBe('正在识别…');
  });
});
