import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogSink, installCrashHooks } from './logs';

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-log-'));
  dirs.push(d);
  return d;
}

/** 固定时钟，让时间戳断言是确定的。 */
const FIXED_NOW = Date.UTC(2026, 9, 22, 4, 24, 56, 20);

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('createLogSink', () => {
  it('目录不存在时自动创建', () => {
    const base = tempDir();
    const dir = join(base, 'nested', 'logs');
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    sink.write('hello');
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(sink.path(), 'utf8')).toContain('hello');
  });

  it('写出的行带 ISO 时间戳与内容，行尾 CRLF', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    sink.write('[main] 启动');
    const text = readFileSync(sink.path(), 'utf8');
    expect(text).toBe('[2026-10-22T04:24:56.020Z] [main] 启动\r\n');
  });

  it('超过 maxBytes 触发轮转：main.log → main.1.log', () => {
    const dir = tempDir();
    // 单行本身就有 38 字节，上限压到 10 才能保证第二行前必然轮转
    const sink = createLogSink({ dir, maxBytes: 10, now: () => FIXED_NOW });
    sink.write('first-line');
    sink.write('second-line');
    expect(existsSync(join(dir, 'main.1.log'))).toBe(true);
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toContain('first-line');
    // 轮转后新的 main.log 只装后来那行
    expect(readFileSync(sink.path(), 'utf8')).toContain('second-line');
    expect(readFileSync(sink.path(), 'utf8')).not.toContain('first-line');
  });

  it('maxFiles 上限：轮转超过 maxFiles 后最老的被删', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, maxBytes: 20, maxFiles: 3, now: () => FIXED_NOW });
    for (let i = 0; i < 10; i++) sink.write('line-' + i);
    // maxFiles=3 → 只留 main.log / main.1.log / main.2.log
    expect(readdirSync(dir).filter((f) => f.endsWith('.log')).sort()).toEqual([
      'main.1.log',
      'main.2.log',
      'main.log',
    ]);
    const all = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
    expect(all).not.toContain('line-0');
    expect(all).toContain('line-9');
  });

  it('dir 不可写时不抛错（传一个已存在的文件路径当目录）', () => {
    const base = tempDir();
    const asFile = join(base, 'not-a-dir');
    writeFileSync(asFile, 'x', 'utf8');
    const sink = createLogSink({ dir: asFile, now: () => FIXED_NOW });
    expect(() => sink.write('boom')).not.toThrow();
    // 一次失败之后不再重试，也不会抛
    expect(() => sink.write('again')).not.toThrow();
  });

  it('close 之后不再写入', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    sink.write('before');
    sink.close();
    sink.write('after');
    const text = readFileSync(sink.path(), 'utf8');
    expect(text).toContain('before');
    expect(text).not.toContain('after');
  });
});

describe('installCrashHooks', () => {
  it('uncaughtException 写入含 stack 的行', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    const proc = new EventEmitter();
    installCrashHooks(sink, proc);

    const err = new Error('boom');
    proc.emit('uncaughtException', err);

    const text = readFileSync(sink.path(), 'utf8');
    expect(text).toContain('uncaughtException');
    expect(text).toContain('boom');
    // stack 里必然有 Error 名与调用栈
    expect(text).toContain('Error: boom');
  });

  it('unhandledRejection：reason 为字符串 / Error 都能记', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    const proc = new EventEmitter();
    installCrashHooks(sink, proc);

    proc.emit('unhandledRejection', 'plain-string', Promise.resolve());
    proc.emit('unhandledRejection', new Error('rejected'), Promise.resolve());

    const text = readFileSync(sink.path(), 'utf8');
    expect(text).toContain('unhandledRejection: plain-string');
    expect(text).toContain('unhandledRejection: Error: rejected');
  });

  it('传入 app 时记录 render-process-gone 的 reason 与 exitCode', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    const proc = new EventEmitter();
    const app = new EventEmitter();
    installCrashHooks(sink, proc, app);

    app.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 });

    const text = readFileSync(sink.path(), 'utf8');
    expect(text).toContain('render-process-gone');
    expect(text).toContain('reason=crashed');
    expect(text).toContain('exitCode=5');
  });

  it('child-process-gone 同样记录', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    const proc = new EventEmitter();
    const app = new EventEmitter();
    installCrashHooks(sink, proc, app);

    app.emit('child-process-gone', {}, { reason: 'killed', exitCode: 1 });

    const text = readFileSync(sink.path(), 'utf8');
    expect(text).toContain('child-process-gone');
    expect(text).toContain('reason=killed');
  });

  it('不传 app 时不抛错，也不挂 app 钩子', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    const proc = new EventEmitter();
    expect(() => installCrashHooks(sink, proc)).not.toThrow();
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
  });

  it('崩溃钩子里 sink 已经关闭时不抛错', () => {
    const dir = tempDir();
    const sink = createLogSink({ dir, now: () => FIXED_NOW });
    const proc = new EventEmitter();
    installCrashHooks(sink, proc);
    sink.close();
    expect(() => proc.emit('uncaughtException', new Error('late'))).not.toThrow();
  });
});
