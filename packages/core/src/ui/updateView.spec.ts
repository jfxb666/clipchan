import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../types';
import { canClickUpdate, updateButtonLabel, updateStatusText } from './updateView';

describe('updateView', () => {
  it('未检查过时按钮是「检查更新」，可点', () => {
    expect(updateButtonLabel(null)).toBe('检查更新');
    expect(canClickUpdate(null)).toBe(true);
  });

  it('检查中 / 下载中按钮不可点', () => {
    expect(canClickUpdate({ state: 'checking' })).toBe(false);
    expect(canClickUpdate({ state: 'downloading', percent: 10 })).toBe(false);
    expect(updateButtonLabel({ state: 'downloading' })).toBe('下载中…');
  });

  it('下载完成后按钮变成「重启安装」且可点', () => {
    expect(updateButtonLabel({ state: 'downloaded', version: '0.6.0' })).toBe('重启安装');
    expect(canClickUpdate({ state: 'downloaded' })).toBe(true);
  });

  it('空态不说「已是最新」，只说当前版本', () => {
    expect(updateStatusText(null, '0.6.0')).toBe('当前版本 0.6.0');
    expect(updateStatusText({ state: 'idle' }, '0.6.0')).toBe('当前版本 0.6.0');
    // ★ 没点过就说「已是最新」是骗人，空态文案里不能出现这四个字。
    expect(updateStatusText(null, '0.6.0')).not.toContain('已是最新');
  });

  it('下载进度取整并带版本号', () => {
    expect(updateStatusText({ state: 'downloading', version: '0.6.0', percent: 42.7 }, '0.5.0')).toBe(
      '正在下载 0.6.0 43%',
    );
    expect(updateStatusText({ state: 'downloading' }, '0.5.0')).toBe('正在下载…');
  });

  it('错误态优先用主进程给的 message，没有则兜底', () => {
    expect(updateStatusText({ state: 'error', message: '网络不通' }, '0.6.0')).toBe('网络不通');
    expect(updateStatusText({ state: 'error' }, '0.6.0')).toContain('检查更新失败');
  });

  it('发现新版本但还没拿到版本号时不显示 undefined', () => {
    const text = updateStatusText({ state: 'available' }, '0.5.0');
    expect(text).not.toContain('undefined');
    expect(text).toContain('发现新版本');
  });
});
