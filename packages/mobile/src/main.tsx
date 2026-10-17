import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, applyStoredTheme } from '@clipchan/core/ui';
import '@clipchan/core/theme/tokens.css';
import './index.css';
import { createMobileAdapter } from './platform/mobile-adapter';

/**
 * 手机端渲染入口（Task 11）。
 *
 * ★ 界面代码来自 @clipchan/core/ui —— 与桌面端**同一份** App 组件，
 *   两端差异全部收敛在平台适配器里（spec §4 分层）。
 *   main.tsx 只做三件事：注入适配器 → 应用已存主题 → 挂载 <App />。
 *
 * ★ 适配器怎么注入的：core 的 getPlatform() 探测顺序是
 *   「setPlatform() 注入 → globalThis.clipchan → 报错桩」。
 *   createMobileAdapter() 内部会把实例挂到 globalThis.clipchan，
 *   所以这里不需要（也**不能**）从 core 内部路径 import setPlatform：
 *   '@clipchan/core' 的 package.json exports 只开放了 '.'、'./ui' 与 './theme/tokens.css'，
 *   深路径 'core/src/platform/adapter.ts' 在 tsc/bundler 两侧都会解析失败。
 *
 * ★ 样式链路：tokens.css（CSS 变量，不含任何 Tailwind 指令）+ 本地 index.css
 *   （手写的最小工具类补齐层）。手机端不装 tailwindcss —— 见 index.css 顶部说明。
 */
createMobileAdapter();
applyStoredTheme();

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 容器：index.html 被改坏了');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
