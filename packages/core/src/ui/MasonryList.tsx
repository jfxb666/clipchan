import { useEffect, useRef, useState } from 'react';
import { ClipCard } from './ClipCard';
import type { ListBodyProps } from './listBody';
import { columnCountOf, distributeColumns } from './masonry';

/** 首帧还没量到容器宽度时的兜底宽度（约等于一列多一点，量到后立刻校正）。 */
const INITIAL_WIDTH = 320;

/**
 * 瀑布流布局：按容器宽度算列数，贪心把卡片分到最矮的列。
 *
 * ★ 不用 CSS columns：CSS 多列是「先竖后横」的填充顺序，会把时间顺序读成从左到右，
 *   且卡片 hover 位移会跨列撕裂。这里显式算列数组，顺序完全由 distributeColumns 决定。
 */
export function MasonryList({
  items,
  selectedIds,
  term,
  onSelect,
  onPaste,
  onTogglePin,
  onHover,
  onOptimize,
  onContextMenu,
  onDragStart,
}: ListBodyProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(INITIAL_WIDTH);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    // 首帧先同步量一次，避免先按 320 排一版再跳成真实列数。
    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const columns = columnCountOf(width);
  // 列宽 = 总宽减去列间距（gap-tight 8px）后均分；列数为 1 时没有间距。
  const columnWidth = Math.max(0, (width - (columns - 1) * 8) / columns);
  const buckets = distributeColumns(items, columns, columnWidth);

  return (
    <div ref={containerRef} className="flex gap-tight">
      {/*
        列容器用 index 作 key 是有意的（审计 T-N4 复核结论）：
        列没有内在身份 —— "第 3 列"就是它的身份，distributeColumns 也刻意保持列数稳定
        （见 masonry.ts 的空列注释）；真正有身份的是列内条目，它们按 item.id 加 key。
        改成拼出来的稳定列 id 会让宽度变化时每列 DOM 全部重建，反而更差。
        契约由 masonry.spec.ts 的「列骨架的稳定性（T-N4 复核）」钉住。
      */}
      {buckets.map((bucket, index) => (
        <div key={index} className="flex min-w-0 flex-1 flex-col gap-tight">
          {bucket.map((item) => (
            <ClipCard
              key={item.id}
              item={item}
              selected={selectedIds.includes(item.id)}
              term={term}
              onSelect={onSelect}
              onPaste={onPaste}
              onTogglePin={onTogglePin}
              onHover={onHover}
              onOptimize={onOptimize}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
