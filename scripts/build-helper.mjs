#!/usr/bin/env node
/**
 * 构建 Clipchan 原生助手（C#）。
 *
 * 本机没有 .NET SDK，只有 .NET Framework 4.x 自带的 csc.exe，所以直接用 csc 编译，
 * 不引入任何额外工具链。
 *
 * ★ 全局约束（见设计文档 Global Constraints）：助手构建**绝不能阻断打包流程**。
 *   因此 csc 缺失、编译失败、--layout 尺寸不符，本脚本一律只打印警告并以退出码 0 结束。
 *
 * 用法：node scripts/build-helper.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HELPER_DIR = path.join(ROOT, 'packages', 'desktop', 'helper');
const SOURCE = path.join(HELPER_DIR, 'ClipchanHelper.cs');
const DIST = path.join(HELPER_DIR, 'dist');
const EXE = path.join(DIST, 'clipchan-helper.exe');

/** --layout 必须匹配的五个尺寸（x64 实测值，写错会导致 SendInput 静默失效）。 */
const EXPECTED_LAYOUT = {
  SIZE_KEYBDINPUT: 24,
  SIZE_MOUSEINPUT: 32,
  SIZE_HARDWAREINPUT: 8,
  SIZE_INPUT: 40,
  SIZE_GUITHREADINFO: 72,
};

function warn(message) {
  console.warn('[build-helper] 警告: ' + message);
}

/** 按优先级定位 csc.exe：先 64 位 Framework，再 32 位回落。 */
function findCsc() {
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function compile(csc) {
  const args = [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    '/utf8output',
    '/reference:System.dll',
    '/out:' + EXE,
    SOURCE,
  ];
  const result = spawnSync(csc, args, { cwd: HELPER_DIR, encoding: 'utf8', windowsHide: true });
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
  if (output) {
    console.log(output);
  }
  if (result.error) {
    warn('无法启动 csc: ' + result.error.message);
    return false;
  }
  if (result.status !== 0) {
    warn('csc 编译失败（退出码 ' + result.status + '）；跳过助手构建，打包继续。');
    return false;
  }
  return true;
}

/** 跑 --layout 并逐条核对五个尺寸，返回真实输出行。 */
function checkLayout() {
  const result = spawnSync(EXE, ['--layout'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    warn('--layout 执行失败: ' + (result.error?.message ?? 'exit ' + result.status));
    return [];
  }
  const lines = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  console.log('[build-helper] --layout 实际输出:');
  for (const line of lines) {
    console.log('  ' + line);
  }
  let mismatched = false;
  for (const [key, expected] of Object.entries(EXPECTED_LAYOUT)) {
    const line = lines.find((l) => l.startsWith(key + '='));
    const actual = line ? Number(line.slice(key.length + 1)) : NaN;
    if (actual !== expected) {
      mismatched = true;
      warn(key + ' 期望 ' + expected + '，实际 ' + (Number.isNaN(actual) ? '(缺失)' : actual));
    }
  }
  if (mismatched) {
    warn('结构体尺寸不匹配！助手会静默失效（尤其 INPUT != 40 时 SendInput 返回 0）。');
  } else {
    console.log('[build-helper] 五个结构体尺寸全部匹配。');
  }
  return lines;
}

function main() {
  console.log('[build-helper] 构建 Clipchan 原生助手');
  if (!existsSync(SOURCE)) {
    warn('找不到源文件 ' + SOURCE + '；跳过助手构建，打包继续。');
    return 0;
  }
  mkdirSync(DIST, { recursive: true });

  const csc = findCsc();
  if (!csc) {
    warn('本机找不到 csc.exe（.NET Framework 4.x）；跳过助手构建，打包继续。');
    return 0;
  }
  console.log('[build-helper] 使用编译器: ' + csc);

  if (!compile(csc)) {
    return 0;
  }
  if (!existsSync(EXE)) {
    warn('编译报告成功但没有产出 ' + EXE + '；跳过后续自检。');
    return 0;
  }
  console.log('[build-helper] 产出: ' + EXE + ' (' + readdirSync(DIST).join(', ') + ')');
  checkLayout();
  return 0;
}

process.exit(main());
