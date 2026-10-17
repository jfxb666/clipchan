#!/usr/bin/env node
/**
 * 一键打包 Windows 产物（Task 10）。
 *
 * 四步串行，任一步失败即以非 0 退出：
 *   ① node scripts/build-helper.mjs —— 编译 C# 助手。**失败只警告不中断**（spec §10.2 /
 *      Global Constraints）：助手缺失时程序如实降级（autoPaste / frostedGlass 均 false），
 *      而不是打不出包。
 *   ② node scripts/build-main.mjs —— 主进程 TS → dist-electron/main.js（CJS）。
 *   ③ vite build             —— 渲染进程 → dist/。
 *   ④ electron-builder       —— portable（release/Clipchan.exe）+ nsis 安装包。
 *
 * ★ 两条本机实测踩过的坑，都在这里处理：
 *   - ELECTRON_RUN_AS_NODE=1 默认存在，不清掉 electron / electron-builder 会退化成纯 Node
 *     （实测报 Cannot read properties of undefined (reading 'whenReady')）；
 *   - 本机没有 Python，所以 electron-builder 绝不能对原生模块跑 @electron/rebuild
 *     （electron-builder.yml 里已锁 npmRebuild:false + buildDependenciesFromSource:false）。
 *
 * 用法：
 *   node scripts/package-win.mjs                 # portable + nsis
 *   node scripts/package-win.mjs --portable-only # 只打 portable（快速迭代）
 *   node scripts/package-win.mjs --skip-helper   # 跳过助手编译（明知没 csc 时）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP = path.join(ROOT, 'packages', 'desktop');
const HELPER_EXE = path.join(DESKTOP, 'helper', 'dist', 'clipchan-helper.exe');
const RELEASE = path.join(ROOT, 'release');
const BUILDER_CONFIG = path.join(DESKTOP, 'electron-builder.yml');
const NO_HELPER_CONFIG = path.join(DESKTOP, '.electron-builder.no-helper.yml');

const args = process.argv.slice(2);
const PORTABLE_ONLY = args.includes('--portable-only');
const SKIP_HELPER = args.includes('--skip-helper');

/** 去掉 ELECTRON_RUN_AS_NODE —— 本机默认带，不清 electron 会退化成纯 Node。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function run(label, command, commandArgs, opts = {}) {
  console.log('\n[package-win] ▶ ' + label);
  console.log('[package-win]   ' + command + ' ' + commandArgs.join(' '));
  const result = spawnSync(command, commandArgs, {
    cwd: opts.cwd ?? ROOT,
    env: cleanEnv(opts.env ?? {}),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error('[package-win] ✗ ' + label + ' 启动失败: ' + result.error.message);
    return 1;
  }
  const code = result.status ?? 1;
  console.log('[package-win] ' + (code === 0 ? '✓' : '✗') + ' ' + label + ' 退出码 ' + code);
  return code;
}

// ── ① 助手（失败只警告） ────────────────────────────────────────────────
let helperOk = existsSync(HELPER_EXE);
if (!SKIP_HELPER) {
  const code = run('① 编译 C# 助手', process.execPath, [path.join(ROOT, 'scripts', 'build-helper.mjs')]);
  if (code !== 0) console.warn('[package-win] ⚠ 助手编译失败（不阻断打包）：自动粘贴与毛玻璃会如实降级');
  helperOk = existsSync(HELPER_EXE);
}
if (!helperOk) {
  console.warn('[package-win] ⚠ 助手 exe 不存在：本次打包将使用一份去掉 extraResources 的临时配置');
  console.warn('[package-win]   （electron-builder 的 extraResources 缺文件会直接失败，而助手缺失本身是允许的）');
}

// ── ② 主进程 ────────────────────────────────────────────────────────────
if (run('② 打包主进程', process.execPath, [path.join(ROOT, 'scripts', 'build-main.mjs')]) !== 0) {
  console.error('[package-win] 主进程打包失败，终止');
  process.exit(1);
}

// ── ③ 渲染进程 ──────────────────────────────────────────────────────────
const viteBin = path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error('[package-win] 找不到 vite：' + viteBin);
  process.exit(1);
}
if (run('③ 构建渲染进程', process.execPath, [viteBin, 'build'], { cwd: DESKTOP }) !== 0) {
  console.error('[package-win] 渲染进程构建失败，终止');
  process.exit(1);
}

// ── ④ electron-builder ─────────────────────────────────────────────────
const builderCli = path.join(DESKTOP, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!existsSync(builderCli)) {
  console.error('[package-win] 找不到 electron-builder：' + builderCli);
  process.exit(1);
}

let configPath = BUILDER_CONFIG;
if (!helperOk) {
  // 用文本方式只摘掉 helper 那一条 extraResources（图标那条必须留着），写成临时配置。
  const yml = existsSync(BUILDER_CONFIG) ? readFileSync(BUILDER_CONFIG, 'utf8') : '';
  const patched = yml.replace(
    /[ \t]+- from: helper\/dist\/clipchan-helper\.exe\n[ \t]+to: clipchan-helper\.exe\n/,
    ''
  );
  writeFileSync(NO_HELPER_CONFIG, patched, 'utf8');
  configPath = NO_HELPER_CONFIG;
}

const targets = PORTABLE_ONLY ? ['portable'] : ['portable', 'nsis'];
const builderCode = run(
  '④ electron-builder（' + targets.join(' + ') + '）',
  process.execPath,
  [builderCli, '--config', path.basename(configPath), '--win', ...targets, '--publish', 'never'],
  {
    cwd: DESKTOP,
    env: {
      ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  }
);

// ── 结果 ────────────────────────────────────────────────────────────────
console.log('\n[package-win] 产物目录：' + RELEASE);
let produced = [];
try {
  produced = readdirSync(RELEASE)
    .map((name) => path.join(RELEASE, name))
    .filter((p) => statSync(p).isFile())
    .filter((p) => /\.(exe|blockmap|yml|zip)$/i.test(p));
  for (const p of produced) console.log('  ' + path.basename(p) + '  ' + statSync(p).size + ' 字节');
} catch (e) {
  console.error('[package-win] 读取 release 目录失败：' + String(e));
}

if (!helperOk) {
  console.log('[package-win] 备注：本次产物**不含**助手 exe，autoPaste / frostedGlass 会显示为不可用。');
}
if (builderCode !== 0) {
  console.error('[package-win] electron-builder 失败（退出码 ' + builderCode + '）');
  process.exit(builderCode);
}
if (!produced.some((p) => /Clipchan\.exe$/i.test(p))) {
  console.error('[package-win] 退出码 0 但没找到 release/Clipchan.exe');
  process.exit(1);
}
console.log('[package-win] 完成');
