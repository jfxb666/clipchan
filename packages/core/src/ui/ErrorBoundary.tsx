/**
 * ★ 重点：整个界面的崩溃兜底。渲染进程任何一次抛错都会让 React 卸载整棵树，
 *   没有这层就是白屏——用户除了杀进程没有别的办法，而且不知道数据还在不在。
 *
 * ★ 为什么只能是 class 组件：React 18 没有函数式的错误边界，
 *   getDerivedStateFromError / componentDidCatch 只在 class 上生效，这是官方唯一入口。
 * ★ 为什么 reload 之前要把错误详情留给用户复制：崩溃信息只存在于当前这一帧内存里，
 *   一按「重新加载」它就永久消失了，主进程日志那边用户也够不着。所以按钮顺序上
 *   「复制错误详情」必须能在 reload 之前被点到，且复制的内容要自足（版本 + 时间 + 堆栈）。
 * ★ 为什么 console.error 就够：打包后用户看不到 devtools，但主进程侧已有独立日志，
 *   这里再加一套上报通道只会引入新依赖；保留 console.error 让开发期能直接看到。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { crashReportText, describeError } from './errorBoundaryLogic';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 崩溃报告里要带上的版本号；不传就用「未知版本」。 */
  appVersion?: string;
  /** 替换默认的 location.reload()，方便测试或宿主自定义重启方式。 */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  /** 捕获到的抛出物；null 表示当前健康。 */
  error: unknown;
  /** 「已复制」的临时态，2 秒后自动复原。 */
  copied: boolean;
}

const CARD_CLASS =
  'mx-auto flex h-full max-w-[520px] flex-col items-center justify-center gap-base px-comfortable text-center';
const PRIMARY_BTN_CLASS =
  'rounded-button bg-[var(--cc-primary)] px-comfortable py-snug text-[12px] text-white hover:opacity-90';
const SECONDARY_BTN_CLASS =
  'rounded-button border border-line px-comfortable py-snug text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink';

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, copied: false };

  /** React 要求这里是静态的纯函数：不能有副作用，只能把错误塞进 state 触发兜底渲染。 */
  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error, copied: false };
  }

  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 组件栈比错误堆栈更能定位是哪一块 UI 炸的，开发期直接看这一行就够。
    console.error('[Clipchan] 界面崩溃', error, info.componentStack);
  }

  override componentWillUnmount(): void {
    // 定时器不清理会在卸载后 setState，React 会打一条无意义的警告。
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
  }

  private handleReload = (): void => {
    const { onReload } = this.props;
    if (onReload) {
      onReload();
      return;
    }
    // 兜底：宿主没给重启方式时直接重载页面，重载后 store 会重新从主进程拉历史。
    window.location.reload();
  };

  private handleCopy = (): void => {
    const text = crashReportText(this.state.error, this.props.appVersion ?? '未知版本', {
      userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    });
    const write = navigator.clipboard?.writeText?.(text);
    if (!write) return;
    void write
      .then(() => {
        this.setState({ copied: true });
        if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.setState({ copied: false }), 2000);
      })
      // 剪贴板被浏览器策略拒绝时静默失败：兜底页上再弹一个错误框只会更糟，
      // 用户仍然可以在下面 <details> 里手动选中复制。
      .catch(() => undefined);
  };

  override render(): ReactNode {
    const { error, copied } = this.state;
    if (error === null) return this.props.children;

    const { title, detail } = describeError(error);
    return (
      <div className={CARD_CLASS}>
        <h1 className="text-[15px] font-semibold text-ink">界面出错了</h1>
        <p className="max-w-[400px] text-[12px] leading-[1.7] text-ink-2">
          这不影响你的剪贴板历史，重启后数据还在。
        </p>
        <div className="flex items-center gap-snug">
          <button type="button" className={PRIMARY_BTN_CLASS} onClick={this.handleReload}>
            重新加载
          </button>
          <button type="button" className={SECONDARY_BTN_CLASS} onClick={this.handleCopy}>
            {copied ? '已复制' : '复制错误详情'}
          </button>
        </div>
        <p className="max-w-[400px] break-words text-[11px] leading-[1.6] text-ink-3">{title}</p>
        {detail ? (
          <details className="w-full text-left">
            <summary className="cursor-pointer text-[11px] text-ink-3">技术细节</summary>
            <pre className="cc-scroll mt-tight max-h-[200px] overflow-auto rounded-card border border-line bg-surface-2 p-snug text-left font-mono text-[11px] leading-[1.6] text-ink-2">
              {detail}
            </pre>
          </details>
        ) : null}
      </div>
    );
  }
}
