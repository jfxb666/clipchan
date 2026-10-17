#!/usr/bin/env node
/**
 * 主进程冒烟：真跑一次 Electron，断言窗口/IPC/托盘/形态尺寸都对。
 *
 * ★ 双通道取结果：主进程既往 stdout 打 `SMOKE {...}`，也写 dist-electron/smoke-result.json。
 *   本机实测"用管道抓 Electron 的 stdout 偶尔会挂住"，所以文件是可靠通道，stdout 是补充。
 * ★ 必须清 ELECTRON_RUN_AS_NODE（否则 electron 退化成 node）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMain } from './build-main.mjs';
/**
 * 通道总数：不能 import .ts（Node 直跑不了 TS），所以从源码里数引号字符串。
 * ★ 数错了会立刻在断言里暴露（期望值也会一起错），所以这里只是"预期值来源"，
 *   真正被验证的是主进程 registeredChannels().length 与它一致。
 */
function countChannels() {
  const src = readFileSync(path.join(DESKTOP, 'electron', 'channels.ts'), 'utf8');
  const body = src.slice(src.indexOf('export const CH'), src.indexOf('export const EV'));
  return new Set(body.match(/'[a-z]+:[A-Za-z]+'/g) || []).size;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'packages', 'desktop');
const RESULT = path.join(DESKTOP, 'dist-electron', 'smoke-result.json');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function parseSmoke(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('SMOKE ');
    if (i >= 0) {
      try {
        return JSON.parse(line.slice(i + 6));
      } catch {
        /* 继续找下一行 */
      }
    }
  }
  return null;
}

async function main() {
  console.log('[smoke] 打包主进程…');
  buildMain({ root: ROOT });
  rmSync(RESULT, { force: true });

  const exe = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(exe)) throw new Error('找不到 electron.exe：' + exe);

  console.log('[smoke] 启动 Electron --smoke…');
  const child = spawn(exe, ['.', '--smoke'], { cwd: DESKTOP, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('[smoke] 30 秒超时，强杀。');
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(false);
    }, 30000);
    child.on('exit', () => { clearTimeout(timer); resolve(true); });
  });

  let data = parseSmoke(stdout);
  if (!data && existsSync(RESULT)) data = parseSmoke(readFileSync(RESULT, 'utf8'));
  if (!data) {
    console.error('[smoke] 没拿到 SMOKE 行。stdout=\n' + stdout + '\nstderr=\n' + stderr);
    process.exit(1);
  }

  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };

  check('windowCreated', data.windowCreated === true, data.windowCreated);
  const sizes = data.modeSizes || {};
  check('主窗口 900x620', Array.isArray(sizes.main) && sizes.main[0] === 900 && sizes.main[1] === 620, JSON.stringify(sizes.main));
  check('小组件 280x420', Array.isArray(sizes.widget) && sizes.widget[0] === 280 && sizes.widget[1] === 420, JSON.stringify(sizes.widget));
  check('切回主窗口仍是 900x620', Array.isArray(sizes.backToMain) && sizes.backToMain[0] === 900 && sizes.backToMain[1] === 620, JSON.stringify(sizes.backToMain));
  const expectedChannels = countChannels();
  check('IPC 通道数 = ' + expectedChannels, data.ipcChannels === expectedChannels, data.ipcChannels);
  check('托盘顶层 6 项', Array.isArray(data.trayItems) && data.trayItems.length === 6, JSON.stringify(data.trayItems));
  check('托盘文案顺序', JSON.stringify(data.trayItems) === JSON.stringify(['显示面板', '暂停监听（幽灵模式）', 'Enter 自动粘贴', '开机自启', '设置…', '退出']), JSON.stringify(data.trayItems));
  check('capabilities 形状完整', data.capabilities && typeof data.capabilities.autoPaste === 'boolean' && typeof data.capabilities.backgroundCapture === 'boolean', JSON.stringify(data.capabilities));
  check('数据目录是 smoke 临时目录', typeof data.dataDir === 'string' && data.dataDir.includes('clipchan-smoke-'), data.dataDir);

  // ★ Task 8：窗口必须落在"鼠标所在那块显示器"的工作区内（spec §6.6）。
  const disp = data.cursorDisplay;
  const bounds = data.modeBounds || {};
  const inDisplay = (b) => {
    if (!disp || !b) return false;
    const wa = disp.workArea;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height;
  };
  check('主窗口落在鼠标所在显示器内', inDisplay(bounds.main), JSON.stringify(bounds.main));
  check('小组件落在鼠标所在显示器内', inDisplay(bounds.widget), JSON.stringify(bounds.widget));
  check('切回主窗口后仍在显示器内', inDisplay(bounds.backToMain), JSON.stringify(bounds.backToMain));
  check('主窗口 bounds 为 900x620', !!bounds.main && bounds.main.width === 900 && bounds.main.height === 620, JSON.stringify(bounds.main));

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log((c.ok ? '  [PASS] ' : '  [FAIL] ') + c.name + (c.ok ? '' : ' —— 实际 ' + c.detail));
  }
  console.log('[smoke] ' + (checks.length - failed) + '/' + checks.length + ' 通过');
  if (!exited) console.warn('[smoke] 进程是被强杀的（超时），请注意。');
  if (stderr.trim()) console.log('[smoke] stderr:\n' + stderr.trim().slice(0, 2000));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke] 失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
