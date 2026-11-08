import { AnimatePresence, motion } from 'framer-motion';
import type { ToastAction, ToastTone } from './toastText';
import { riseMotion, useRespectReducedMotion } from './motion';
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
  warn: 'bg-accent-soft text-accent border-accent-soft',
  error: 'bg-accent text-on-accent border-accent',
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
  // P3 动效层（c 项）：toast 滑入滑出。动机：提示条从底部「冒出来」是状态出现的
  //   位置语义，进出场同一副面孔（y 8→0 + 淡入 200ms；退出反向 150ms）让用户能预期
  //   它从哪来回哪去；退场由外层 ToastStack 的 AnimatePresence 驱动（TTL 到点 /
  //   手动关闭都走同一动画）。reduced-motion 时 riseMotion 退化为直接出现/消失。
  const reduced = useRespectReducedMotion();
  return (
    <motion.div
      role="status"
      className={cn(
        // 进场交给 framer（riseMotion），不再挂 .cc-pop——两套进场动画会互相打架。
        'pointer-events-auto flex max-w-[420px] items-center gap-tight rounded-button border px-snug py-tight text-left text-[12px] leading-[1.6] shadow-panel',
        TONE_CLASS[toast.tone],
      )}
      {...riseMotion(reduced)}
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
          className="cc-no-drag shrink-0 rounded-button border border-line bg-surface px-snug py-[2px] text-[11px] font-medium text-primary hover:bg-surface-2"
        >
          {toast.action.label}
        </button>
      ) : null}
    </motion.div>
  );
}

/**
 * 浮层容器：底部居中堆叠，点任意一条可提前关掉。
 * ★ P3 动效层（c 项）：AnimatePresence 让每条 toast 在移除时先播 150ms 退场再卸载。
 *   原来的「toasts 空就整层 return null」必须拿掉——最后一个 toast 退场时容器得
 *   还挂着，否则退出动画没有宿主可播。空容器只是不可见（absolute + pointer-events-none）。
 */
export function ToastStack({
  toasts,
  onDismiss,
  className,
}: {
  toasts: ToastItem[];
  onDismiss?: (id: number) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'cc-no-drag pointer-events-none absolute bottom-comfortable left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-tight',
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}
