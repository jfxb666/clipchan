import type { ToastTone } from './toastText';
import { cn } from './util';

/** 单条浮层提示。与 store 里的 Toast 结构一致（这里不 import store，保持组件可单测）。 */
export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

const TONE_CLASS: Record<ToastTone, string> = {
  ok: 'bg-surface text-ink border-line',
  warn: 'bg-[var(--cc-accent-soft)] text-[var(--cc-accent)] border-[var(--cc-accent-soft)]',
  error: 'bg-[var(--cc-accent)] text-white border-[var(--cc-accent)]',
};

/** 单条提示。 */
export function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss?: (id: number) => void }) {
  return (
    <button
      type="button"
      role="status"
      onClick={() => onDismiss?.(toast.id)}
      className={cn(
        'cc-pop pointer-events-auto max-w-[420px] rounded-button border px-snug py-tight text-left text-[12px] leading-[1.6] shadow-panel',
        TONE_CLASS[toast.tone],
      )}
    >
      {toast.text}
    </button>
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
