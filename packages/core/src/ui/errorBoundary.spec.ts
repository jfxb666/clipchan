/**
 * 崩溃兜底纯逻辑单测。
 *
 * 仓库的 vitest 只跑 node 环境、没有 jsdom（见 trashViewLogic.spec.ts 文件头），
 * ErrorBoundary.tsx 是 class 组件渲染不了；这里断言的是 describeError / crashReportText，
 * 组件只负责把结果摆到 DOM 上并接两个按钮。
 */
import { describe, expect, it } from 'vitest';
import { crashReportText, describeError } from './errorBoundaryLogic';

describe('describeError', () => {
  it('Error 的标题同时带 name 与 message', () => {
    const { title } = describeError(new TypeError('渲染炸了'));
    expect(title).toBe('TypeError: 渲染炸了');
    expect(title).toContain('TypeError');
    expect(title).toContain('渲染炸了');
  });

  it('detail 带堆栈', () => {
    const err = new Error('带堆栈');
    const { detail } = describeError(err);
    expect(detail).toContain('带堆栈');
    expect(detail).toBe(err.stack ?? '');
  });

  it('超长 message 截断到 200 字符以内，且带上省略号', () => {
    const { title } = describeError(new Error('长'.repeat(5000)));
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith('…')).toBe(true);
  });

  it('超长堆栈截断到 4000 字符以内', () => {
    const err = new Error('长堆栈');
    err.stack = 'x'.repeat(9000);
    const { detail } = describeError(err);
    expect(detail.length).toBeLessThanOrEqual(4000);
  });

  it('字符串 / 对象 / null / undefined / 数字都不抛', () => {
    expect(() => describeError('炸了')).not.toThrow();
    expect(describeError('炸了').title).toBe('炸了');
    expect(describeError({ a: 1 }).title).toBe('[object Object]');
    expect(describeError(null).title).toBe('未知错误');
    expect(describeError(undefined).title).toBe('未知错误');
    expect(describeError(42).title).toBe('42');
    // 非 Error 没有堆栈可给，detail 保持空串而不是 'undefined'。
    expect(describeError('炸了').detail).toBe('');
  });

  it('message getter 抛错时仍返回「未知错误」而不是把异常漏出去', () => {
    const bomb = {
      get message(): string {
        throw new Error('getter 也炸了');
      },
      get name(): string {
        throw new Error('getter 也炸了');
      },
      get stack(): string {
        throw new Error('getter 也炸了');
      },
    };
    expect(() => describeError(bomb)).not.toThrow();
    expect(describeError(bomb).title).toBe('未知错误');
  });

  it('跨 realm 的错误（不是 instanceof Error）也能读出 message', () => {
    const foreign = { name: 'RangeError', message: '越界了', stack: 'at x' };
    expect(describeError(foreign).title).toBe('RangeError: 越界了');
    expect(describeError(foreign).detail).toBe('at x');
  });
});

describe('crashReportText', () => {
  it('含版本号、ISO 时间与 detail', () => {
    const err = new Error('渲染炸了');
    const at = new Date('2024-05-06T07:08:09.000Z');
    const text = crashReportText(err, '0.6.2', { at });
    expect(text).toContain('0.6.2');
    expect(text).toContain('2024-05-06T07:08:09.000Z');
    expect(text).toContain('Error: 渲染炸了');
    expect(text).toContain(err.stack ?? '');
  });

  it('注入 userAgent 才写环境行', () => {
    const at = new Date('2024-05-06T07:08:09.000Z');
    expect(crashReportText(new Error('x'), '0.6.2', { at, userAgent: 'FakeAgent/1.0' })).toContain(
      'FakeAgent/1.0',
    );
    expect(crashReportText(new Error('x'), '0.6.2', { at })).not.toContain('环境：');
  });

  it('非 Error 也能生成报告，不抛', () => {
    const at = new Date('2024-05-06T07:08:09.000Z');
    expect(() => crashReportText(null, '0.6.2', { at })).not.toThrow();
    expect(crashReportText(null, '0.6.2', { at })).toContain('未知错误');
  });
});
