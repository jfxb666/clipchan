import { ClipCard } from './ClipCard';
import type { ListBodyProps } from './listBody';
import { groupByDay } from './timeline';

/** 分组标题：粘在滚动容器顶部，滚动时始终知道自己在哪一天。 */
const GROUP_HEADER_CLASS =
  'sticky top-0 z-[1] bg-surface/95 px-base py-[6px] text-[11px] font-medium text-ink-2 backdrop-blur';

/**
 * 时间轴布局：按天分组，每组一个 sticky 标题 + 组内卡片。
 *
 * ★ 只改排列方式，卡片仍然是同一个 ClipCard —— 三个视图共用一套交互与视觉。
 */
export function TimelineList({
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
  const groups = groupByDay(items);

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <section key={group.key}>
          <h3 className={GROUP_HEADER_CLASS}>{group.label}</h3>
          <div className="flex flex-col gap-tight pt-tight">
            {group.items.map((item) => (
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
        </section>
      ))}
    </div>
  );
}
