import { useEffect, useRef } from 'react';
import type { ClipItemDTO, KindFilter } from '../types';
import { ClipCard } from './ClipCard';
import { EmptyState } from './EmptyState';

/** 触底阈值：滚动位置距底小于该值时拉下一页（spec §6.3 / §8.1）。 */
export const LOAD_MORE_THRESHOLD_PX = 200;

/**
 * 卡片列表（spec §6.3）：8px 间距，滚到底自动拉下一页。
 * 长列表靠每张卡片的 content-visibility 裁剪，不用虚拟滚动库。
 */
export function ListPanel({
  items,
  kind,
  q,
  selectedIds,
  loading,
  onSelect,
  onPaste,
  onTogglePin,
  onHover,
  onLoadMore,
}: {
  items: ClipItemDTO[];
  kind: KindFilter;
  q: string;
  selectedIds: string[];
  loading: boolean;
  onSelect: (id: string, opts?: { multi?: boolean }) => void;
  onPaste: (id: string) => void;
  onTogglePin: (id: string) => void;
  onHover?: (id: string | null) => void;
  onLoadMore: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 换分类 / 换搜索词后回到顶部，避免停留在上一份列表的滚动位置。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [kind, q]);

  return (
    <div
      ref={scrollRef}
      className="cc-scroll flex-1 overflow-y-auto px-base py-snug"
      onScroll={(event) => {
        const el = event.currentTarget;
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceToBottom < LOAD_MORE_THRESHOLD_PX) onLoadMore();
      }}
    >
      {items.length === 0 ? (
        <EmptyState kind={kind} q={q} />
      ) : (
        <div className="flex flex-col gap-tight">
          {items.map((item) => (
            <ClipCard
              key={item.id}
              item={item}
              selected={selectedIds.includes(item.id)}
              onSelect={onSelect}
              onPaste={onPaste}
              onTogglePin={onTogglePin}
              onHover={onHover}
            />
          ))}
          {loading ? (
            <p className="py-snug text-center text-[11px] text-ink-3">正在加载更多…</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
