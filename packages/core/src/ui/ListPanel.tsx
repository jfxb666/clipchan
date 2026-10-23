import { useEffect, useRef } from 'react';
import type { ClipItemDTO, KindFilter, ListLayout } from '../types';
import { ClipCard } from './ClipCard';
import { EmptyState } from './EmptyState';
import { shouldShowFirstRun } from './firstRun';
import type { ListBodyProps } from './listBody';
import { MasonryList } from './MasonryList';
import { SourceGroupList } from './SourceGroupList';
import { TimelineList } from './TimelineList';

/** 触底阈值：滚动位置距底小于该值时拉下一页（spec §6.3 / §8.1）。 */
export const LOAD_MORE_THRESHOLD_PX = 200;

/** 骨架条数量：够填满一屏即可，多画只是浪费。 */
export const LIST_SKELETON_ROWS = 4;

/**
 * 首屏骨架。store 的 load() 一进来就 set({loading:true})，此时 items 还是空数组 ——
 * 直接渲染 EmptyState 会先闪一下「还没有记录」，等数据回来又跳成列表（冷启动闪烁）。
 */
function ListSkeleton() {
  return (
    <div className="flex flex-col gap-tight" aria-hidden>
      {Array.from({ length: LIST_SKELETON_ROWS }, (_, index) => (
        <div
          key={index}
          className="flex animate-pulse items-start gap-snug rounded-card border border-line bg-[var(--cc-surface)] p-snug"
        >
          <div className="h-4 w-8 shrink-0 rounded-[4px] bg-surface-2" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-3/4 rounded-[4px] bg-surface-2" />
            <div className="mt-tight h-3 w-1/3 rounded-[4px] bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 卡片列表（spec §6.3）：8px 间距，滚到底自动拉下一页。
 * 长列表靠每张卡片的 content-visibility 裁剪，不用虚拟滚动库。
 *
 * v0.4.0：list 视图内部多了三种排列方式（时间轴 / 瀑布流 / 按来源分组）。
 * ★ 布局只换「同一批 items 怎么排」，滚动容器与触底分页三种布局共用。
 */
export function ListPanel({
  items,
  kind,
  q,
  selectedIds,
  loading,
  layout = 'list',
  onSelect,
  onPaste,
  onTogglePin,
  onHover,
  onOptimize,
  onLoadMore,
  onContextMenu,
  onDragStart,
  hasAnyItems = true,
}: {
  items: ClipItemDTO[];
  kind: KindFilter;
  q: string;
  selectedIds: string[];
  loading: boolean;
  /** 布局模式（v0.4.0）；缺省 'list'，这样 App 未接线时行为不变。 */
  layout?: ListLayout;
  onSelect: (id: string, opts?: { multi?: boolean }) => void;
  onPaste: (id: string) => void;
  onTogglePin: (id: string) => void;
  onHover?: (id: string | null) => void;
  /** 打开优化面板并带出全文（计划 Task 7 Step 6）。 */
  onOptimize?: (id: string) => void;
  onLoadMore: () => void;
  /** 右键菜单入口；未传则卡片不响应右键。 */
  onContextMenu?: (id: string, x: number, y: number) => void;
  /** 拖出到外部应用（v0.6.0）；未传则卡片不可拖。 */
  onDragStart?: (id: string) => void;
  /**
   * 库里到底有没有记录（不是当前筛选后的条数）。
   * ★ 默认 true：没接线时宁可不显示首次引导，也不要对着一个有记录的库喊「去复制点什么」。
   */
  hasAnyItems?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 换分类 / 换搜索词 / 换布局后回到顶部：三种情况下列表内容都整体变了，
  // 停在原来的滚动位置会落在毫无关系的一条记录上。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [kind, q, layout]);

  const showSkeleton = items.length === 0 && loading;
  const bodyProps: ListBodyProps = {
    items,
    selectedIds,
    term: q,
    onSelect,
    onPaste,
    onTogglePin,
    onHover,
    onOptimize,
    onContextMenu,
    onDragStart,
  };

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
      {showSkeleton ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <EmptyState kind={kind} q={q} showFirstRun={shouldShowFirstRun(kind, q, hasAnyItems)} />
      ) : (
        <>
          {layout === 'timeline' ? (
            <TimelineList {...bodyProps} />
          ) : layout === 'masonry' ? (
            <MasonryList {...bodyProps} />
          ) : layout === 'source' ? (
            <SourceGroupList {...bodyProps} />
          ) : (
            <div className="flex flex-col gap-tight">
              {items.map((item) => (
                <ClipCard
                  key={item.id}
                  item={item}
                  selected={selectedIds.includes(item.id)}
                  term={q}
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
          )}
          {loading ? (
            <p className="py-snug text-center text-[11px] text-ink-3">正在加载更多…</p>
          ) : null}
        </>
      )}
    </div>
  );
}
