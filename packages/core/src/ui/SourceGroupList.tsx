import { ClipCard } from './ClipCard';
import type { ListBodyProps } from './listBody';
import { groupBySource } from './sourceGroups';

const GROUP_HEADER_CLASS =
  'sticky top-0 z-[1] bg-surface/95 px-base py-[6px] text-[11px] font-medium text-ink-2 backdrop-blur';

/**
 * 按来源分组布局：同一来源应用的记录聚成一组，标题右侧标出条数。
 */
export function SourceGroupList({
  items,
  selectedIds,
  term,
  onSelect,
  onPaste,
  onTogglePin,
  onHover,
  onOptimize,
  onContextMenu,
}: ListBodyProps) {
  const groups = groupBySource(items);

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <section key={group.key}>
          <h3 className={GROUP_HEADER_CLASS}>
            <span className="flex items-center justify-between gap-tight">
              <span className="truncate">{group.label}</span>
              <span className="shrink-0 text-ink-3">{group.items.length} 条</span>
            </span>
          </h3>
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
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
