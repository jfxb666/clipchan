import type { ToastAction, ToastTone } from './toastText';
import { cn } from './util';

/** 单条浮层提示。与 store 里的 Toast 结构一致（这里不 import store，保持组件可单测）。 */
export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  /** 可点动作（撤销）；没给就只渲染纯文案。 */
  action?: ToastAction;
}

const TONE_CLASS: Record<ToastTone, string> = {
  ok: 'bg-surface text-ink border-line',
  warn: 'bg-[var(--cc-accent-soft)] text-[var(--cc-accent)] border-[var(--cc-accent-soft)]',
  error: 'bg-[var(--cc-accent)] text-white border-[var(--cc-accent)]',
};

/**
 * 单条提示。
 *
 * ★ 外层从 <button> 改成了 <div role="status">：撤销按钮本身必须是 <button>，
 *   而 <button> 里套 <button> 是非法 HTML —— 浏览器会把内层按钮踢出外层，
 *   于是"点提示条任意位置关闭"与"点撤销"两个热区重叠、行为不确定。
 *   改成 div 之后：文案 + 关闭热区是一个 button，撤销按钮是它的**兄弟节点**，
 *   两个热区在 DOM 上彻底分开，不需要 stopPropagation 去救。
 */
export function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss?: (id: number) => void }) {
  const dismissible = Boolean(onDismiss);
  return (
    <div
      role="status"
      className={cn(
        'cc-pop pointer-events-auto flex max-w-[420px] items-center gap-tight rounded-button border px-snug py-tight text-left text-[12px] leading-[1.6] shadow-panel',
        TONE_CLASS[toast.tone],
      )}
    >
      {dismissible ? (
        <button
          type="button"
          onClick={() => onDismiss?.(toast.id)}
          className="min-w-0 flex-1 text-left"
        >
          {toast.text}
        </button>
      ) : (
        <span className="min-w-0 flex-1">{toast.text}</span>
      )}

      {toast.action ? (
        <button
          type="button"
          onClick={() => {
            // 点撤销后立刻收掉这条提示：撤销的结果由 store 另弹一条（成功 / 部分失败），
            // 留着旧的「已删除 N 条」会与结果提示并排出现，看着像没生效。
            onDismiss?.(toast.id);
            toast.action?.onClick();
          }}
          // cc-no-drag：提示条浮在标题栏拖拽区上方，不标的话点击会被拖拽区吃掉。
          className="cc-no-drag shrink-0 rounded-button border border-line bg-surface px-snug py-[2px] text-[11px] font-medium text-[var(--cc-primary)] hover:bg-surface-2"
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );
}

/** 浮层容器：底部居中堆叠，点任意一条可提前关掉。 */
export function ToastStack({
  toasts,
  onDismiss,
  className,
}: {
  toasts: ToastItem[];
  onDismiss?: (id: number) => void;
  className?: string;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className={cn(
        'cc-no-drag pointer-events-none absolute bottom-comfortable left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-tight',
        className,
      )}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
