import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

/**
 * 渲染进程的 Vite 配置。
 * ★ 不用 rspack（ojo 原型用的是 rspack，那是"原型预览宿主"的构建内核，不复用 —— spec §4）。
 * ★ `base: './'` 是为了打包后 file:// 加载时资源路径正确。
 */
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@clipchan/core': path.resolve(__dirname, '..', 'core', 'src'),
    },
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome120',
    // 两个页面入口：主窗口 index.html 与截图 overlay capture.html（铁律一：overlay
    // 是独立页面，不塞进 App 的 View 里）。overlay 由主进程按显示器分别 loadFile。
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        capture: path.resolve(__dirname, 'capture.html'),
      },
    },
  },
});
