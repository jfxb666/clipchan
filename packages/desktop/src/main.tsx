import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, applyStoredTheme } from '@clipchan/core/ui';
import './index.css';

/**
 * 渲染进程入口。
 * 界面全部来自 @clipchan/core/ui，桌面端只负责挂载与主题落盘，
 * 这样同一套界面将来可以直接搬去移动端（spec §4 分层）。
 */

// 先把用户上次选的主题写进 <html data-theme>，避免首帧闪成浅色。
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
