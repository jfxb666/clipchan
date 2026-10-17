import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { HelperClient, defaultHelperExePath, parseHelperLine } from './helper';

describe('parseHelperLine', () => {
  it('READY pid=<n>', () => {
    expect(parseHelperLine('READY pid=1234')).toEqual({ kind: 'READY', pid: 1234 });
  });

  it('RESULT <句柄> <码> <说明>', () => {
    expect(parseHelperLine('RESULT 65536 0 ok')).toEqual({
      kind: 'RESULT',
      hwnd: 65536,
      code: 0,
      note: 'ok',
    });
  });

  it('RESULT 的中文说明逐字保留', () => {
    expect(parseHelperLine('RESULT 65536 1 窗口失效')).toEqual({
      kind: 'RESULT',
      hwnd: 65536,
      code: 1,
      note: '窗口失效',
    });
  });

  it('BLUR <句柄> <码>', () => {
    expect(parseHelperLine('BLUR 65536 0')).toEqual({ kind: 'BLUR', hwnd: 65536, code: 0 });
  });

  it('FG <句柄>', () => {
    expect(parseHelperLine('FG 131072')).toEqual({ kind: 'FG', hwnd: 131072 });
  });

  it('PONG <标记>', () => {
    expect(parseHelperLine('PONG tag')).toEqual({ kind: 'PONG', tag: 'tag' });
  });

  it('容忍行尾 CR 与多余空白', () => {
    expect(parseHelperLine('PONG t1\r')).toEqual({ kind: 'PONG', tag: 't1' });
    expect(parseHelperLine('  FG   131072  ')).toEqual({ kind: 'FG', hwnd: 131072 });
  });

  it('畸形行返回 UNKNOWN 而不抛异常', () => {
    const bad = [
      '',
      '   ',
      'garbage',
      'RESULT',
      'RESULT 65536',
      'RESULT 65536 x ok',
      'RESULT x 0 ok',
      'FG abc',
      'BLUR 1',
      'READY pid=',
      'READY pid=abc',
      'PONG',
    ];
    for (const line of bad) {
      expect(() => parseHelperLine(line)).not.toThrow();
      expect(parseHelperLine(line)).toEqual({ kind: 'UNKNOWN', raw: line });
    }
  });
});

describe('defaultHelperExePath', () => {
  it('默认指向 packages/desktop/helper/dist/clipchan-helper.exe', () => {
    const p = defaultHelperExePath().replace(/\\/g, '/');
    expect(p.endsWith('packages/desktop/helper/dist/clipchan-helper.exe')).toBe(true);
  });
});

describe('HelperClient 降级（不假装）', () => {
  it('exe 不存在时 available=false，paste/blur/foreground 诚实降级且不抛异常', async () => {
    const missing = path.join(tmpdir(), 'clipchan-missing-helper-' + Date.now(), 'clipchan-helper.exe');
    expect(existsSync(missing)).toBe(false);
    const client = new HelperClient({ exePath: missing });
    expect(client.available).toBe(false);
    await expect(client.paste(65536)).resolves.toEqual({ ok: false, reason: 'send-failed' });
    await expect(client.blur(65536, true, 0xcc1a1a1a)).resolves.toBe(false);
    await expect(client.foreground()).resolves.toBe(0);
    expect(() => client.prewarm()).not.toThrow();
    await expect(client.dispose()).resolves.toBeUndefined();
  });
});

// ---- 用假子进程验证请求-响应配对 / 超时 / 崩溃重启（不依赖真实 exe） ----

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (chunk: string) => boolean };
  kill: (signal?: string) => boolean;
  killed: boolean;
}

function makeFake(responder: (line: string, child: FakeChild) => void) {
  const children: FakeChild[] = [];
  const spawnImpl = (_exe: string, _args: string[]): ChildProcess => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.stdin = {
      write: (chunk: string): boolean => {
        const line = chunk.replace(/\r?\n$/, '');
        queueMicrotask(() => {
          if (line === 'QUIT') {
            child.emit('exit', 0);
            return;
          }
          responder(line, child);
        });
        return true;
      },
    };
    child.kill = (): boolean => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', 0));
      return true;
    };
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawnImpl, children };
}

describe('HelperClient 与假助手进程', () => {
  it('请求-响应按行配对并把结果码映射成 PasteResult', async () => {
    const { spawnImpl, children } = makeFake((line, child) => {
      if (line === 'PASTE 65536') child.stdout.emit('data', 'RESULT 65536 0 ok\n');
      if (line === 'FG') child.stdout.emit('data', 'FG 131072\n');
      if (line === 'BLUR 65536 1 3424262682') child.stdout.emit('data', 'BLUR 65536 0\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\clipchan-helper.exe', spawnImpl });
    expect(client.available).toBe(true);
    await expect(client.paste(65536)).resolves.toEqual({ ok: true });
    await expect(client.foreground()).resolves.toBe(131072);
    await expect(client.blur(65536, true, 0xcc1a1a1a)).resolves.toBe(true);
    expect(children.length).toBe(1);
    await client.dispose();
    expect(children[0]?.killed).toBe(false);
  });

  it('paste 接受 bigint 句柄（计划接口契约），协议仍走十进制', async () => {
    const { spawnImpl } = makeFake((line, child) => {
      if (line === 'PASTE 65536') child.stdout.emit('data', 'RESULT 65536 0 ok\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.paste(65536n)).resolves.toEqual({ ok: true });
    await client.dispose();
  });

  it('非法句柄直接返回安全值，不写入进程', async () => {
    const written: string[] = [];
    const spawnImpl = (): ChildProcess => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.stdin = {
        write: (chunk: string): boolean => {
          written.push(chunk.trim());
          return true;
        },
      };
      child.kill = () => true;
      return child as unknown as ChildProcess;
    };
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.paste(-1)).resolves.toEqual({ ok: false, reason: 'send-failed' });
    await expect(client.paste(Number.NaN)).resolves.toEqual({ ok: false, reason: 'send-failed' });
    expect(written).toEqual([]);
    await client.dispose();
  });

  it('半行数据会缓冲到换行再解析', async () => {
    const { spawnImpl } = makeFake((line, child) => {
      if (line === 'PASTE 0') {
        // 故意拆成两段，验证客户端按换行缓冲而不是按 data 事件解析
        child.stdout.emit('data', 'RESULT 0 1 窗');
        child.stdout.emit('data', '口失效\n');
      }
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.paste(0)).resolves.toEqual({ ok: false, reason: 'no-target' });
    expect(client.available).toBe(true);
    await client.dispose();
  });

  it('无响应时超时返回安全值，不抛异常', async () => {
    const { spawnImpl } = makeFake(() => {});
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl, timeoutMs: 20 });
    await expect(client.paste(1)).resolves.toEqual({ ok: false, reason: 'send-failed' });
    await expect(client.blur(1, true)).resolves.toBe(false);
    await expect(client.foreground()).resolves.toBe(0);
    await client.dispose();
  });

  it('stdout 关闭 → 标记不可用 → 最多自动重启一次', async () => {
    let spawns = 0;
    const spawnImpl = (): ChildProcess => {
      spawns += 1;
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.stdin = { write: () => true };
      child.kill = () => true;
      queueMicrotask(() => child.stdout.emit('close'));
      return child as unknown as ChildProcess;
    };
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl, timeoutMs: 50 });
    await client.paste(1);
    expect(spawns).toBe(1);
    expect(client.available).toBe(false);
    await client.paste(1);
    expect(spawns).toBe(2);
    expect(client.available).toBe(false);
    await client.paste(1);
    expect(spawns).toBe(2);
    expect(client.available).toBe(false);
    await client.dispose();
  });
});

// ---- 真实 exe 集成（构建产物存在时才跑） ----

const realExe = defaultHelperExePath();
describe.skipIf(!existsSync(realExe))('HelperClient 对接真实 exe', () => {
  it('FG 返回十进制前台句柄', async () => {
    const client = new HelperClient({ exePath: realExe });
    expect(client.available).toBe(true);
    const hwnd = await client.foreground();
    expect(Number.isInteger(hwnd)).toBe(true);
    expect(hwnd).toBeGreaterThan(0);
    await client.dispose();
  });

  it('PASTE 0 → no-target（窗口失效码 1）', async () => {
    const client = new HelperClient({ exePath: realExe });
    await expect(client.paste(0)).resolves.toEqual({ ok: false, reason: 'no-target' });
    await client.dispose();
  });

  it('BLUR 0 ... → false（无效句柄）', async () => {
    const client = new HelperClient({ exePath: realExe });
    await expect(client.blur(0, true, 0xcc1a1a1a)).resolves.toBe(false);
    await client.dispose();
  });

  it('dispose 发 QUIT 且进程退出', async () => {
    const client = new HelperClient({ exePath: realExe });
    await client.foreground();
    await expect(client.dispose()).resolves.toBeUndefined();
  });
});
