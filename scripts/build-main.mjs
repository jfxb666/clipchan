/**
 * 把 packages/desktop/electron/*.ts 打包成 Electron 能直接跑的 CJS。
 *
 * ★ 为什么不用 tsc：本机 packages/desktop 是 "type":"commonjs"，而源码用 import +
 *   import.meta.url；cjs 输出格式下 import.meta 会被 esbuild 判为空对象，所以用
 *   --banner 定义 __cc_import_meta_url，再用 --define 把 import.meta.url 指向它。
 *   （spec §15 实测：这条是唯一可行的组合。）
 * ★ 为什么不用 node_modules/.bin/esbuild：pnpm 没提升 bin，且 esbuild 的 JS 包装在
 *   pnpm 环境下静默失败（退出码 0、无产物）。必须用原生 exe。
 * ★ 参数必须用等号形式（--outfile=...），空格分隔会被判为 "Invalid build flag"。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'packages', 'desktop');
const ELECTRON_DIR = path.join(DESKTOP, 'electron');
const OUT_DIR = path.join(DESKTOP, 'dist-electron');

/** 找出 esbuild 原生可执行文件。找不到就抛，绝不静默继续。 */
export function findEsbuild(root = ROOT) {
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const d of fs.readdirSync(pnpmDir)) {
      if (!d.startsWith('@esbuild+win32-x64@')) continue;
      const exe = path.join(pnpmDir, d, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  const plain = path.join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
  if (fs.existsSync(plain)) return plain;
  throw new Error('找不到 esbuild 原生可执行文件（@esbuild/win32-x64）。请先 pnpm install --allow-build=esbuild');
}

/** 打包一个入口。返回产物绝对路径。 */
export function bundle(entry, outfile, { root = ROOT } = {}) {
  const esbuild = findEsbuild(root);
  const args = [
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    '--external:electron',
    '--external:better-sqlite3',
    '--banner:js=const __cc_import_meta_url = require(\'node:url\').pathToFileURL(__filename).href;',
    '--define:import.meta.url=__cc_import_meta_url',
    '--log-level=warning',
    '--outfile=' + outfile,
  ];
  const r = spawnSync(esbuild, args, { cwd: root, encoding: 'utf8', shell: false });
  if (r.status !== 0) {
    throw new Error('esbuild 打包失败(' + entry + '):\n' + (r.stderr || '') + (r.stdout || ''));
  }
  if (r.stderr && r.stderr.trim().length > 0) process.stderr.write(r.stderr);
  if (!fs.existsSync(outfile)) throw new Error('esbuild 报告成功但没有产物: ' + outfile);
  return outfile;
}

/** 打包主进程 + preload，并写一个给 --smoke 用的小页面。 */
export function buildMain({ root = ROOT } = {}) {
  const desktop = path.join(root, 'packages', 'desktop');
  const electronDir = path.join(desktop, 'electron');
  const outDir = path.join(desktop, 'dist-electron');
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  files.push(bundle(path.join(electronDir, 'main.ts'), path.join(outDir, 'main.js'), { root }));
  files.push(bundle(path.join(electronDir, 'preload.ts'), path.join(outDir, 'preload.js'), { root }));
  const smokeHtml = path.join(outDir, 'smoke.html');
  fs.writeFileSync(
    smokeHtml,
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>clipchan smoke</title></head>' +
      '<body><div id="smoke">smoke</div></body></html>',
    'utf8'
  );
  files.push(smokeHtml);
  return files;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const files = buildMain();
    for (const f of files) {
      const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
      console.log('[build-main] ' + path.relative(ROOT, f) + ' (' + size + ' B)');
    }
    console.log('[build-main] 完成');
  } catch (err) {
    console.error('[build-main] 失败: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }
}
