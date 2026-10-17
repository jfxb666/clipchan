#!/usr/bin/env node
/**
 * 开发启动器：Vite dev server + Electron（指向它）。
 *
 * ★ 第一步必须清 ELECTRON_RUN_AS_NODE —— 本机该环境变量默认为 1，不清的话
 *   electron.exe 会退化成纯 Node，报 "Cannot read properties of undefined (reading 'whenReady')"
 *   （spec §3 约束表 / §15 实测）。
 * ★ 主进程代码改动不会被 HMR 覆盖：改 electron/** 要重启本脚本（spec §10.1）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMain } from './build-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'packages', 'desktop');
const PORT = Number(process.env.CLIPCHAN_DEV_PORT || 5173);
const URL_ = 'http://127.0.0.1:' + PORT + '/';

/** 干净环境：清掉会让 electron 退化成 node 的变量。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function electronExe() {
  const p = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (existsSync(p)) return p;
  throw new Error('找不到 electron.exe：' + p + '（先跑 pnpm install --allow-build=electron）');
}

function viteEntry() {
  const p = path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js');
  if (existsSync(p)) return p;
  throw new Error('找不到 vite：' + p);
}

/** 轮询 dev server 直到 200，最多 30 秒。 */
async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_);
      if (res.status === 200) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log('[dev] 1/3 打包主进程…');
  buildMain({ root: ROOT });

  console.log('[dev] 2/3 启动 Vite dev server（' + URL_ + '）…');
  const vite = spawn(process.execPath, [viteEntry(), '--port', String(PORT), '--strictPort'], {
    cwd: DESKTOP,
    env: cleanEnv(),
    stdio: 'inherit',
  });
  vite.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error('[dev] Vite 退出，码 ' + code);
  });

  if (!(await waitForServer())) {
    console.error('[dev] Vite 30 秒内没起来，放弃。');
    vite.kill();
    process.exit(1);
  }
  console.log('[dev] Vite 已就绪。');

  console.log('[dev] 3/3 启动 Electron…');
  const electron = spawn(electronExe(), ['.'], {
    cwd: DESKTOP,
    env: cleanEnv({ VITE_DEV_SERVER_URL: URL_ }),
    stdio: 'inherit',
  });

  electron.on('exit', (code) => {
    console.log('[dev] Electron 退出，码 ' + code);
    vite.kill();
    process.exit(code ?? 0);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      electron.kill();
      vite.kill();
    });
  }
}

main().catch((e) => {
  console.error('[dev] 失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
