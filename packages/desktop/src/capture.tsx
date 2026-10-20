/**
 * 截图 overlay 的挂载点（计划 §1 铁律一 / §3 T3）。
 *
 * ★ 为什么不套 StrictMode：overlay 里每次挂载都会注册 window 的 keydown/resize
 *   监听并向主进程要底图；StrictMode 开发期的双跑会让同一份监听注册两遍、
 *   底图请求发两次，屏幕上出现两份遮罩。
 * ★ 为什么平台能力在这里取一次再传下去：overlay 是独立挂载点，没有 App 那层
 *   注入点；组件本身仍然不碰 getPlatform，保持与 OptimizeViewCard 同一风格。
 * ★ 为什么用 @clipchan/core/... 子路径而不是相对路径 ../../core/src/...：
 *   desktop 的 tsconfig 设了 rootDir: "."，相对路径把 core 源码拉进同一个 program
 *   会报 TS6059（文件不在 rootDir 下）。子路径走 package.json exports，core 源码
 *   作为独立 project 解析，两边都干净。vite 侧有 '@clipchan/core' 别名兜底。
 */
import { createRoot } from 'react-dom/client';
import { getPlatform } from '@clipchan/core/platform/adapter';
import { CaptureOverlay } from '@clipchan/core/ui/CaptureOverlay';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(<CaptureOverlay platform={getPlatform()} />);
