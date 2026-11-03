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
  // ★ 生产剥 console（Task 12 / T-N7）：调试日志不进发行包。保留 warn/error ——
  //   排查线上问题还得靠它们。dev 不受影响：dev 只做 transform 不打包，esbuild 对
  //   pure 标记只加 /* @__PURE__ */ 注释、不删调用（实测验证过），代码原样执行。
  //   注意这个选项是 Vite 的顶层 esbuild 配置（build 下没有 esbuild 这个键），
  //   build 的 esbuild 压缩也会读到它，两条路径都会剥。
  esbuild: {
    pure: ['console.log', 'console.debug', 'console.info'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // ★ 生产不出源映射：这是公开仓库的发行包，sourcemap 等于把源码原样发给下载者，
    //   而项目自己早就为"转公开"做过脱敏（见提交 ed74f30），留着 map 与之自相矛盾。
    //   需要排查线上问题时：CLIPCHAN_SOURCEMAP=1 临时开（'hidden' = 出 map 但产物不引用）。
    sourcemap: process.env.CLIPCHAN_SOURCEMAP === '1' ? 'hidden' : false,
    minify: 'esbuild',
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
