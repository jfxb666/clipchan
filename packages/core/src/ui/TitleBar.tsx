import { Minus, X } from 'lucide-react';
import type { AppMode, View } from '../state/store';
import { formatRemaining } from './util';

/**
 * 自定义标题栏（spec §6.3 / §6.8）。
 * 左侧应用名 + 幽灵模式常驻状态点，右侧最小化 / 关闭（关闭 = 隐藏到托盘）。
 * 整条可拖动（.cc-drag），里面的按钮必须 .cc-no-drag。
 */
export function TitleBar({
  view,
  mode,
  ghostActive,
  ghostRemainingMs,
  onBack,
  onHide,
  onClose,
}: {
  view: View;
  mode: AppMode;
  ghostActive: boolean;
  ghostRemainingMs: number;
  onBack: () => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const title = view === 'settings' ? '设置' : view === 'wordcloud' ? '今日词云' : '剪贴板酱';
  return (
    <header className="cc-drag flex h-[38px] shrink-0 items-center gap-tight border-b border-line px-base">
      <div className="flex min-w-0 items-center gap-tight">
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        {view !== 'list' ? (
          <button
            type="button"
            onClick={onBack}
            className="cc-no-drag rounded-button px-tight py-[2px] text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            返回列表
          </button>
        ) : null}
        {mode === 'widget' ? <span className="text-[11px] text-ink-3">小组件</span> : null}
      </div>

      <div className="flex-1" />

      {/* 幽灵模式：常驻暗红圆点 + 剩余时间（spec §6.8） */}
      {ghostActive ? (
        <span
          className="cc-no-drag flex items-center gap-tight rounded-full bg-[var(--cc-accent-soft)] px-tight py-[3px] text-[11px] text-[var(--cc-accent)]"
          title="幽灵模式中，复制的任何内容都不会被记录，也不会在结束后补录"
        >
          <span className="h-[7px] w-[7px] rounded-full bg-[var(--cc-accent)]" />
          幽灵模式 · 剩余 {formatRemaining(ghostRemainingMs)}
        </span>
      ) : null}

      <button
        type="button"
        title="最小化"
        onClick={onHide}
        className="cc-no-drag rounded-button p-[5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        <Minus size={14} aria-hidden />
      </button>
      <button
        type="button"
        title="隐藏到托盘"
        onClick={onClose}
        className="cc-no-drag rounded-button p-[5px] text-ink-2 hover:bg-[var(--cc-accent-soft)] hover:text-[var(--cc-accent)]"
      >
        <X size={14} aria-hidden />
      </button>
    </header>
  );
}
