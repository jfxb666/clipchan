import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 壳配置。
 * ★ 本轮**只搭壳**：没有执行 `npx cap add android`，也没有 android/ 目录。
 *   真机打包需要先装 JDK 17 + Android SDK + Gradle，再 cap add android
 *   （见 README「怎么跑」一节）。缺这三样时 cap add 会直接失败。
 * ★ webDir 'dist' 与 vite.config.ts 的 build.outDir 一致：
 *   先 `pnpm --filter @clipchan/mobile build` 产出 dist/，cap sync 才会把它拷进原生工程。
 */
const config: CapacitorConfig = {
  appId: 'com.clipchan.app',
  appName: '剪贴板酱',
  webDir: 'dist',
};

export default config;
