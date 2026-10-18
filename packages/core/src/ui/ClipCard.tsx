import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { ImageIcon, Sparkles, Star } from 'lucide-react';
import type { ClipItemDTO } from '../types';
import { TypeBadge } from './TypeBadge';
import { cn, formatTime } from './util';

/**
 * 列表卡片（spec §6.3 / §6.5）。
 * 交互铁律：**单击 = 选中，双击 = 粘贴**（单击即粘贴误触率太高）。
 * Ctrl / Shift + 单击 = 多选（供 Ctrl+M 拼接）。
 *
 * 长列表裁剪用 CSS content-visibility，不引虚拟滚动库（spec §8.1）。
 */
export function ClipCard({
  item,
  selected,
  onSelect,
  onPaste,
  onTogglePin,
  onHover,
  onOptimize,
}: {
  item: ClipItemDTO;
  selected: boolean;
  onSelect: (id: string, opts?: { multi?: boolean }) => void;
  onPaste: (id: string) => void;
  onTogglePin: (id: string) => void;
  onHover?: (id: string | null) => void;
  /** 打开优化面板并带出全文；未传则不渲染「优化」按钮。 */
  onOptimize?: (id: string) => void;
}) {
  const isCode = item.kind === 'code';
  return (
    <motion.div
      layout
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 280, damping: 20 }}
      onClick={(event) => {
        const multi = event.ctrlKey || event.metaKey || event.shiftKey;
        onSelect(item.id, multi ? { multi: true } : undefined);
      }}
      onDoubleClick={() => onPaste(item.id)}
      onMouseEnter={() => onHover?.(item.id)}
      onMouseLeave={() => onHover?.(null)}
      title="单击选中 · 双击粘贴"
      // ★ 用户实测反馈：右侧两个按钮原先写的是 opacity-0 + group-hover 才显形，
      //   打包版里 computed opacity 恒为 0 —— 用户根本找不到优化入口。改成常态半透明
      //   （opacity-60）+ 悬停不透明，不再依赖 hover 才可见（也不再需要 group）。
      className={cn(
        'relative flex cursor-default items-start gap-snug rounded-card border bg-surface p-snug shadow-card',
        selected
          ? 'border-[var(--cc-primary)] ring-1 ring-[var(--cc-primary)]'
          : 'border-line hover:border-[var(--cc-border-strong)]',
      )}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '96px' } as CSSProperties}
    >
      <TypeBadge kind={item.kind} className="mt-[2px]" />

      {item.kind === 'image' ? (
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-button bg-surface-2">
          {item.thumbUrl ? (
            <img src={item.thumbUrl} alt="" className="h-16 w-16 object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center text-ink-3">
              <ImageIcon size={20} aria-hidden />
            </div>
          )}
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'line-clamp-2 break-all text-[13px] leading-[1.6] text-ink',
            isCode && 'font-mono text-[12px]',
          )}
        >
          {item.preview}
        </p>
        <div className="mt-tight flex items-center gap-tight text-[11px] text-ink-3">
          <span>{formatTime(item.createdAt)}</span>
          {item.sizeLabel ? <span>· {item.sizeLabel}</span> : null}
          {item.source === 'merge' ? <span>· 拼接</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-[2px]">
        {onOptimize ? (
          <button
            type="button"
            title="优化提示词"
            onClick={(event) => {
              // 同收藏按钮：单击只开优化面板，不能顺带选中卡片。
              event.stopPropagation();
              onOptimize(item.id);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className="shrink-0 rounded-full p-[3px] text-ink-3 opacity-60 transition-colors hover:opacity-100 hover:text-[var(--cc-primary)]"
          >
            <Sparkles size={14} aria-hidden />
          </button>
        ) : null}

        <button
          type="button"
          title={item.pinned ? '取消收藏' : '收藏（Ctrl+D）'}
          onClick={(event) => {
            // 固定按钮：单击不能冒泡成"选中卡片"。
            event.stopPropagation();
            onTogglePin(item.id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            'shrink-0 rounded-full p-[3px] transition-colors',
            item.pinned
              ? 'text-[var(--cc-warm)]'
              : 'text-ink-3 opacity-60 hover:opacity-100 hover:text-[var(--cc-warm)]',
          )}
        >
          <Star size={14} fill={item.pinned ? 'currentColor' : 'none'} aria-hidden />
        </button>
      </div>
    </motion.div>
  );
}
