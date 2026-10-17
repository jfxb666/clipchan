import { describe, expect, it } from 'vitest';
import { ensureAutoStart, readAutoStart } from './autostart';
import type { AutoStartDeps } from './startup';

/** 假登录项：记录写入，读取返回当前值（模仿 Electron 的 app.getLoginItemSettings）。 */
function fakeDeps(initial = false) {
  const calls: { openAtLogin: boolean; path?: string }[] = [];
  let open = initial;
  const deps: AutoStartDeps = {
    getLoginItemSettings: (opts?: { path?: string }) => {
      if (opts?.path !== undefined) calls.push({ openAtLogin: open, path: opts.path });
      return { openAtLogin: open };
    },
    setLoginItemSettings: (opts: { openAtLogin: boolean; path?: string }) => {
      calls.push({ openAtLogin: opts.openAtLogin, path: opts.path });
      open = opts.openAtLogin;
    },
  };
  return { deps, calls, isOpen: () => open };
}

const EXEC = 'C:\\Users\\me\\Desktop\\release\\Clipchan.exe';

describe('autostart（Task 10 / 验收 19）', () => {
  it('portable：Run 键写的是 PORTABLE_EXECUTABLE_FILE，不是 process.execPath', () => {
    const env = { PORTABLE_EXECUTABLE_FILE: EXEC };
    const f = fakeDeps();
    const r = ensureAutoStart(true, f.deps, env, 'C:\\Users\\me\\AppData\\Local\\Temp\\2F3A\\Clipchan.exe');
    expect(r.ok).toBe(true);
    expect(r.path).toBe(EXEC);
    expect(f.calls.at(-1)!.path).toBe(EXEC);
    expect(f.calls.at(-1)!.path).not.toContain('Temp');
  });

  it('非 portable（PORTABLE_EXECUTABLE_FILE 为空）回落 process.execPath', () => {
    const f = fakeDeps();
    const r = ensureAutoStart(true, f.deps, { PORTABLE_EXECUTABLE_FILE: '   ' }, EXEC);
    expect(r.path).toBe(EXEC);
    expect(f.calls.at(-1)!.path).toBe(EXEC);
  });

  it('关闭自启：写入 false 并回读为 false（ok=写入成功，不是"当前开着"）', () => {
    const f = fakeDeps(true);
    const r = ensureAutoStart(false, f.deps, {}, EXEC);
    expect(r.path).toBe(EXEC);
    expect(f.isOpen()).toBe(false);
    // ★ 回归：曾经 setAutoStart 返回传入的 on，关闭时返回 false →
    //   ensureAutoStart 恒报 ok:false → 设置页把已关掉的开关回滚成"开"
    //   （真机实测：注册表已清空、界面仍显示开启）。ok 必须是"写入成功"。
    expect(r.ok).toBe(true);
  });

  it('写入成功但回读不一致时 ok=false（不假装成功）', () => {
    let open = false;
    const stubborn: AutoStartDeps = {
      getLoginItemSettings: () => ({ openAtLogin: open }),
      setLoginItemSettings: (opts) => {
        // 假装系统接受了写入，但把它当成"永远开启"（模拟策略锁定）
        open = true;
      },
    };
    const r = ensureAutoStart(false, stubborn, {}, EXEC);
    expect(r.ok).toBe(false);
  });

  it('读状态：已开启返回 ok=true，未开启返回 ok=false，路径始终可读', () => {
    const on = fakeDeps(true);
    const off = fakeDeps(false);
    expect(readAutoStart(on.deps, { PORTABLE_EXECUTABLE_FILE: EXEC }, EXEC)).toEqual({ ok: true, path: EXEC });
    expect(readAutoStart(off.deps, {}, EXEC)).toEqual({ ok: false, path: EXEC });
  });

  it('读写都不抛：底层抛异常时 ok=false，path 仍然给出', () => {
    const boom: AutoStartDeps = {
      getLoginItemSettings: () => { throw new Error('拒绝访问注册表'); },
      setLoginItemSettings: () => { throw new Error('拒绝访问注册表'); },
    };
    const r = ensureAutoStart(true, boom, { PORTABLE_EXECUTABLE_FILE: EXEC }, EXEC);
    expect(r).toEqual({ ok: false, path: EXEC });
    expect(readAutoStart(boom, {}, EXEC)).toEqual({ ok: false, path: EXEC });
  });
});
