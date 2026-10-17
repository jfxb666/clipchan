import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

/**
 * 手机端（Capacitor 壳）的 Vite 配置。
 * ★ 与桌面端同构：base './' 让 WebView 用 file:// 或 capacitor:// 加载时资源路径正确；
 *   '@clipchan/core' 别名直指 core 源码，所以两端跑的是**同一份界面代码**（spec §4 分层）。
 * ★ port 5174：避开桌面端预览的 5173，方便同时开两个 dev server（strictPort: false
 *   让端口被占时自动顺延，而不是直接失败 —— 手机端预览没有那么强的"必须是 5174"诉求）。
 * ★ target 'chrome100'：Android 10 自带的 System WebView 大约在 Chrome 8x-9x，
 *   取 100 是「比它略高一点但仍属现代浏览器」的折中；真机若报语法错误，往下调到 'chrome90'。
 * ★ __dirname：本文件的 ESM 语义下它不存在，但 tsc 走 moduleResolution=bundler + types:["node"]
 *   会按 CJS 认它。这里显式声明一次，让 tsc 与 vite 两边都能过（同 desktop 的写法）。
 */
declare const __dirname: string;

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@clipchan/core': path.resolve(__dirname, '..', 'core', 'src'),
    },
  },
  server: { port: 5174, strictPort: false },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome100',
  },
});
