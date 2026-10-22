/**
 * 自动更新的纯逻辑测试。
 *
 * ★ 这里**不构造 Updater**：它的构造里 require('electron-updater')，那个包一加载就
 *   import electron，在纯 node 的 vitest 下会直接抛。事件 → 状态、能不能安装这两块
 *   是全部有判断价值的分支，抽成纯函数后可以脱离 electron 测干净。
 */
import { describe, expect, it } from 'vitest';
import { canApply, statusFromEvent } from './updater';

describe('statusFromEvent：electron-updater 六个事件 → 界面状态', () => {
  it('checking-for-update 回 checking', () => {
    expect(statusFromEvent('checking-for-update')).toEqual({ state: 'checking' });
  });

  it('update-available 带上新版本号', () => {
    expect(statusFromEvent('update-available', { version: '0.6.0' })).toEqual({
      state: 'available',
      version: '0.6.0',
    });
  });

  it('update-available 没有版本号时也回 available（不崩、不出现 undefined 字段）', () => {
    const s = statusFromEvent('update-available', {});
    expect(s).toEqual({ state: 'available' });
    expect(s && 'version' in s).toBe(false);
  });

  it('update-not-available 回 none，并在文案里带上当前版本', () => {
    const s = statusFromEvent('update-not-available', {}, '0.5.0');
    expect(s).toEqual({ state: 'none', message: '已是最新版本（v0.5.0）' });
  });

  it('update-not-available 缺当前版本时文案降级但仍可用', () => {
    expect(statusFromEvent('update-not-available')).toEqual({ state: 'none', message: '已是最新版本' });
  });

  it('download-progress 把 percent 取整', () => {
    expect(statusFromEvent('download-progress', { percent: 42.6 })).toEqual({
      state: 'downloading',
      percent: 43,
    });
  });

  it('download-progress 的越界 / 非数字 percent 被夹进 0~100（进度条画出格）', () => {
    expect(statusFromEvent('download-progress', { percent: 103 })).toEqual({ state: 'downloading', percent: 100 });
    expect(statusFromEvent('download-progress', { percent: -5 })).toEqual({ state: 'downloading', percent: 0 });
    expect(statusFromEvent('download-progress', { percent: 'x' })).toEqual({ state: 'downloading', percent: 0 });
    expect(statusFromEvent('download-progress')).toEqual({ state: 'downloading', percent: 0 });
  });

  it('update-downloaded 带上版本号', () => {
    expect(statusFromEvent('update-downloaded', { version: '0.6.0' })).toEqual({
      state: 'downloaded',
      version: '0.6.0',
    });
  });

  it('error 归一成一句中文，绝不把 electron-updater 的原始报错抛给界面', () => {
    const s = statusFromEvent('error', new Error('HttpError: 404 https://api.github.com/...'));
    expect(s).toEqual({ state: 'error', message: '检查更新失败，请稍后重试' });
    // 原始报错里的内部地址不能出现在给用户看的那条 message 上
    expect(s?.message).not.toContain('github.com');
  });

  it('未知事件回 null（以后 electron-updater 多出事件也不会推垃圾状态）', () => {
    expect(statusFromEvent('update-cancelled', {})).toBeNull();
    expect(statusFromEvent('')).toBeNull();
  });
});

describe('canApply：只有下载完才能安装', () => {
  it('downloaded 才允许安装', () => {
    expect(canApply({ state: 'downloaded', version: '0.6.0' })).toBe(true);
  });

  it('其余状态一律不允许（否则用户点一下应用就退了）', () => {
    for (const state of ['idle', 'checking', 'none', 'available', 'downloading', 'error'] as const) {
      expect(canApply({ state })).toBe(false);
    }
  });
});
