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

  it('FGEXE <句柄> <exe名>', () => {
    expect(parseHelperLine('FGEXE 12345 Code.exe')).toEqual({
      kind: 'FGEXE',
      hwnd: 12345,
      exe: 'Code.exe',
    });
  });

  it('FGEXE 取不到时助手发 "FGEXE 0 -"，解析层照收（判 null 是客户端的事）', () => {
    expect(parseHelperLine('FGEXE 0 -')).toEqual({ kind: 'FGEXE', hwnd: 0, exe: '-' });
  });

  it('FGEXE 畸形行返回 UNKNOWN：句柄非数字 / 少一段 / 多一段', () => {
    // 多一段的情况是 exe 名里带空格（"My App.exe"）：宁可没有来源，
    // 也不要把名字截成 "My" 记一个错的来源。
    for (const line of ['FGEXE abc Code.exe', 'FGEXE 123', 'FGEXE 123 Code.exe extra', 'FGEXE']) {
      expect(parseHelperLine(line)).toEqual({ kind: 'UNKNOWN', raw: line });
    }
  });

  // ★ 用 JSON.stringify 造行：手写转义太容易数错反斜杠，而真实助手发的就是 JSON。
  it('FILES <json数组>：解析出路径列表', () => {
    const paths = ['C:\\a\\b.txt', 'D:\\c.txt'];
    expect(parseHelperLine('FILES ' + JSON.stringify(paths))).toEqual({ kind: 'FILES', paths });
    expect(parseHelperLine('FILES []')).toEqual({ kind: 'FILES', paths: [] });
  });

  it('FILES 的路径里有空格也照收（不能按空白切分）', () => {
    const paths = ['C:\\Program Files\\a.txt'];
    expect(parseHelperLine('FILES ' + JSON.stringify(paths))).toEqual({ kind: 'FILES', paths });
  });

  it('FILES 畸形行返回 UNKNOWN：缺 JSON / 非数组 / 元素全非字符串', () => {
    for (const line of ['FILES', 'FILES ', 'FILES not-json', 'FILES {"a":1}', 'FILES [1,2]']) {
      expect(parseHelperLine(line)).toEqual({ kind: 'UNKNOWN', raw: line });
    }
  });

  it('FILES 数组里混了非字符串元素时只留字符串', () => {
    expect(parseHelperLine('FILES ' + JSON.stringify(['C:\\a.txt', 3]))).toEqual({
      kind: 'FILES',
      paths: ['C:\\a.txt'],
    });
  });

  it('FILESET <返回码>：0 成功，非 0 是失败码', () => {
    expect(parseHelperLine('FILESET 0')).toEqual({ kind: 'FILESET', code: 0 });
    expect(parseHelperLine('FILESET 5')).toEqual({ kind: 'FILESET', code: 5 });
  });

  it('FILESET 畸形行返回 UNKNOWN：缺码 / 非十进制 / 多一段', () => {
    for (const line of ['FILESET', 'FILESET ', 'FILESET x', 'FILESET -1', 'FILESET 0 1']) {
      expect(parseHelperLine(line)).toEqual({ kind: 'UNKNOWN', raw: line });
    }
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
    await expect(client.foregroundExe()).resolves.toBeNull();
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
      if (line === 'FGEXE') child.stdout.emit('data', 'FGEXE 131072 Code.exe\n');
      if (line === 'BLUR 65536 1 3424262682') child.stdout.emit('data', 'BLUR 65536 0\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\clipchan-helper.exe', spawnImpl });
    expect(client.available).toBe(true);
    await expect(client.paste(65536)).resolves.toEqual({ ok: true });
    await expect(client.foreground()).resolves.toBe(131072);
    await expect(client.foregroundExe()).resolves.toBe('Code.exe');
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
    await expect(client.foregroundExe()).resolves.toBeNull();
    await client.dispose();
  });

  it('助手回 "FGEXE 0 -" → foregroundExe() 归一成 null（取不到来源）', async () => {
    const { spawnImpl } = makeFake((line, child) => {
      if (line === 'FGEXE') child.stdout.emit('data', 'FGEXE 0 -\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.foregroundExe()).resolves.toBeNull();
    await client.dispose();
  });

  it('readFiles 拿到 FILES 行的路径列表', async () => {
    const { spawnImpl } = makeFake((line, child) => {
      if (line === 'FILES') {
        child.stdout.emit('data', 'FILES ' + JSON.stringify(['C:\\a.txt', 'C:\\b.txt']) + '\n');
      }
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.readFiles()).resolves.toEqual(['C:\\a.txt', 'C:\\b.txt']);
    await client.dispose();
  });

  it('readFiles 拿到空数组（剪贴板上没有文件）', async () => {
    const { spawnImpl } = makeFake((line, child) => {
      if (line === 'FILES') child.stdout.emit('data', 'FILES []\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.readFiles()).resolves.toEqual([]);
    await client.dispose();
  });

  it('助手不回 FILES → 超时兜底返回 null（不能当成"没有文件"）', async () => {
    const { spawnImpl } = makeFake(() => {});
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl, timeoutMs: 30 });
    await expect(client.readFiles()).resolves.toBeNull();
    await client.dispose();
  });

  it('writeFiles 发的是单行 JSON，且码 0 → true', async () => {
    const seen: string[] = [];
    const { spawnImpl } = makeFake((line, child) => {
      seen.push(line);
      if (line.startsWith('FILESET ')) child.stdout.emit('data', 'FILESET 0\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    const paths = ['C:\\Program Files\\a.txt', 'D:\\b.txt'];
    await expect(client.writeFiles(paths)).resolves.toBe(true);
    // 路径里有空格，必须是整段 JSON 而不是空格分隔的多段。
    expect(seen).toContain('FILESET ' + JSON.stringify(paths));
    await client.dispose();
  });

  it('writeFiles 收到非 0 码 → false（助手写不出标准 CF_HDROP）', async () => {
    const { spawnImpl } = makeFake((line, child) => {
      if (line.startsWith('FILESET ')) child.stdout.emit('data', 'FILESET 5\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.writeFiles(['C:\\a.txt'])).resolves.toBe(false);
    await client.dispose();
  });

  it('writeFiles 助手不回包 → 超时 false，不抛异常', async () => {
    const { spawnImpl } = makeFake(() => {});
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl, timeoutMs: 30 });
    await expect(client.writeFiles(['C:\\a.txt'])).resolves.toBe(false);
    await client.dispose();
  });

  it('writeFiles 空数组直接 false，不打扰助手', async () => {
    const seen: string[] = [];
    const { spawnImpl } = makeFake((line) => {
      seen.push(line);
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl });
    await expect(client.writeFiles([])).resolves.toBe(false);
    expect(seen.filter((l) => l.startsWith('FILESET'))).toEqual([]);
    await client.dispose();
  });

  it('助手回畸形 FGEXE 行 → 超时兜底返回 null，不抛异常', async () => {
    const { spawnImpl } = makeFake((line, child) => {
      if (line === 'FGEXE') child.stdout.emit('data', 'FGEXE 123 Code.exe extra\n');
    });
    const client = new HelperClient({ exePath: 'C:\\fake\\x.exe', spawnImpl, timeoutMs: 30 });
    await expect(client.foregroundExe()).resolves.toBeNull();
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

  it('FGEXE 返回 exe 名或 null（取决于此刻前台是什么），且不抛异常', async () => {
    const client = new HelperClient({ exePath: realExe });
    const exe = await client.foregroundExe();
    expect(exe === null || /^[^\\/]+\.exe$/i.test(exe)).toBe(true);
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
