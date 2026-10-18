import { ChevronRight, ImageIcon, Star } from 'lucide-react';
import type { ClipItemDTO } from '../types';
import { SearchBar } from './SearchBar';
import { TypeBadge } from './TypeBadge';
import { cn, formatTime } from './util';

/**
 * 小组件形态（spec §6.4 / §6.6）。
 *
 * 与主面板是**同一个 BrowserWindow 换形态**（spec §6.6）：
 * 这里只是把内容换成紧凑版 —— 搜索框 + 最近 10 条 + 「查看全部记录」，
 * 侧栏收起、卡片压扁。React 状态（搜索词、选中项）与主面板共享同一个 store，
 * 所以来回切形态不会丢状态（验收 13）。
 */
export const WIDGET_PREVIEW_COUNT = 10;

/** 只取前 N 条（抽成纯函数是为了能单测，组件本身不需要 DOM 测试）。 */
export function visibleWidgetItems<T>(items: T[], count: number = WIDGET_PREVIEW_COUNT): T[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  return items.slice(0, Math.floor(count));
}

/** 小组件里的一行（比主面板卡片更扁：单行预览 + 小徽章）。 */
function WidgetRow({
  item,
  selected,
  onSelect,
  onPaste,
  onTogglePin,
}: {
  item: ClipItemDTO;
  selected: boolean;
  onSelect: (id: string) => void;
  onPaste: (id: string) => void;
  onTogglePin: (id: string) => void;
}) {
  return (
    <div
      onClick={() => onSelect(item.id)}
      onDoubleClick={() => onPaste(item.id)}
      title="单击选中 · 双击粘贴"
      className={cn(
        'group flex cursor-default items-center gap-[6px] rounded-button border px-[6px] py-[5px]',
        selected
          ? 'border-[var(--cc-primary)] bg-[var(--cc-primary-soft)]'
          : 'border-transparent bg-surface hover:border-line',
      )}
    >
      {item.kind === 'image' ? (
        <div className="h-7 w-7 shrink-0 overflow-hidden rounded-[6px] bg-surface-2">
          {item.thumbUrl ? (
            <img src={item.thumbUrl} alt="" className="h-7 w-7 object-cover" />
          ) : (
            <div className="flex h-7 w-7 items-center justify-center text-ink-3">
              <ImageIcon size={12} aria-hidden />
            </div>
          )}
        </div>
      ) : (
        <TypeBadge kind={item.kind} className="shrink-0 scale-90" />
      )}

      <p className="min-w-0 flex-1 truncate text-[11px] leading-[1.5] text-ink">{item.preview}</p>

      <button
        type="button"
        title={item.pinned ? '取消收藏' : '收藏（Ctrl+D）'}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(item.id);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        className={cn(
          'shrink-0 rounded-full p-[2px] transition-colors',
          item.pinned
            ? 'text-[var(--cc-warm)]'
            : 'text-ink-3 opacity-60 transition-colors group-hover:opacity-100',
        )}
      >
        <Star size={11} fill={item.pinned ? 'currentColor' : 'none'} aria-hidden />
      </button>
    </div>
  );
}

/**
 * 小组件视图（280×420）。
 * 搜索走与主面板同一个 store 的 setQuery（300ms 防抖），所以两边搜索词是同一份。
 */
export function WidgetView({
  items,
  q,
  selectedIds,
  onSelect,
  onPaste,
  onTogglePin,
  onSearch,
  onShowAll,
  className,
}: {
  items: ClipItemDTO[];
  q: string;
  selectedIds: string[];
  onSelect: (id: string) => void;
  onPaste: (id: string) => void;
  onTogglePin: (id: string) => void;
  onSearch: (value: string) => void;
  onShowAll: () => void;
  className?: string;
}) {
  const visible = visibleWidgetItems(items);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="shrink-0 px-snug pt-snug">
        <SearchBar value={q} onChange={onSearch} placeholder="搜索…" />
      </div>

      {/*
        ★ 不再用 flex-1：窗口高度已按内容自适应（见 widgetFit.ts），
          列表再撑满剩余空间就会重新出现「下面一大片空白」（用户反馈）。
          这里让它按内容高度自然生长，超出窗口时自己滚动。
      */}
      <div className="cc-scroll min-h-0 overflow-y-auto px-snug py-tight">
        {visible.length === 0 ? (
          <p className="px-tight py-base text-center text-[11px] text-ink-3">
            {q ? '没有匹配的记录' : '还没有记录'}
          </p>
        ) : (
          <div className="flex flex-col gap-[4px]">
            {visible.map((item) => (
              <WidgetRow
                key={item.id}
                item={item}
                selected={selectedIds.includes(item.id)}
                onSelect={onSelect}
                onPaste={onPaste}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
        )}
        {items.length > visible.length ? (
          <p className="pt-tight text-center text-[10px] text-ink-3">
            仅显示最近 {WIDGET_PREVIEW_COUNT} 条
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-tight border-t border-line px-snug py-[5px] text-[10px] text-ink-3">
        <span>{formatTime(items[0]?.createdAt ?? Date.now())}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onShowAll}
          className="cc-no-drag flex items-center gap-[2px] rounded-button px-[4px] py-[2px] hover:bg-surface-2 hover:text-ink-2"
        >
          查看全部记录
          <ChevronRight size={11} aria-hidden />
        </button>
      </div>
    </div>
  );
}
