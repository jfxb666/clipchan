#!/usr/bin/env node
/**
 * 手工验证用：真跑一次打包后的主进程 + 渲染产物（不开 Vite）。
 * ★ 必须清 ELECTRON_RUN_AS_NODE（本机默认存在，否则 electron 退化成 node）。
 * ★ 只给"人工验收"用，不是构建链路的一环。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'packages', 'desktop');
const exe = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!existsSync(exe)) throw new Error('找不到 electron.exe: ' + exe);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exe, ['.', ...process.argv.slice(2)], {
  cwd: DESKTOP,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code) => process.exit(code ?? 0));
