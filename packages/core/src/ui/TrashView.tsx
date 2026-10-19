import { useEffect, useRef, useState } from 'react';
import { ImageIcon, RotateCcw, Trash2 } from 'lucide-react';
import type { ClipItemDTO } from '../types';
import { TypeBadge } from './TypeBadge';
import { EmptyState } from './EmptyState';
import { LOAD_MORE_THRESHOLD_PX } from './ListPanel';
import {
  EMPTY_TRASH_CONFIRM_TTL_MS,
  deletedAtText,
  EMPTY_TRASH_HINT,
  emptyTrashLabel,
  isTrashEmpty,
  purgeLabel,
  shouldShowEmptyTrash,
  trashTitle,
} from './trashViewLogic';
import { cn } from './util';

/**
 * 回收站视图（v0.3.0）。
 *
 * 刻意**不复用 ListPanel**：那边绑定了 kind 筛选、搜索高亮、双击粘贴、收藏与
 * 右键菜单一整套活跃列表语义，而回收站里这些全都不成立（删掉的记录不能粘贴，
 * 也没有分类页）。这里只保留三件事：类型徽章、预览、删除时间，加两个动作按钮。
 *
 * 所有平台调用都由 App 注入（与 SettingsView / OptimizeView 一致），组件不碰 getPlatform。
 */
export interface TrashViewProps {
  items: ClipItemDTO[];
  total: number;
  loading: boolean;
  onLoadMore: () => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onEmptyTrash: () => void;
}

/** 单条回收站卡片。 */
function TrashCard({
  item,
  pending,
  onRestore,
  onPurge,
}: {
  item: ClipItemDTO;
  pending: boolean;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
}) {
  return (
    <div className="flex items-start gap-snug rounded-card border border-line bg-surface p-snug shadow-card">
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
            item.kind === 'code' && 'font-mono text-[12px]',
          )}
        >
          {item.preview}
        </p>
        <div className="mt-tight flex items-center gap-tight text-[11px] text-ink-3">
          <span>{deletedAtText(item)}</span>
          {item.sizeLabel ? <span>· {item.sizeLabel}</span> : null}
          {item.sourceApp ? <span>· {item.sourceApp}</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-[4px]">
        <button
          type="button"
          title="恢复到列表"
          onClick={() => onRestore(item.id)}
          className="flex items-center gap-[3px] rounded-button border border-line px-snug py-[3px] text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <RotateCcw size={11} aria-hidden />
          恢复
        </button>
        <button
          type="button"
          title={pending ? '再点一次就真的删掉，不可恢复' : '永久删除（连图片文件一起删）'}
          onClick={() => onPurge(item.id)}
          className={cn(
            'flex items-center gap-[3px] rounded-button border px-snug py-[3px] text-[11px]',
            pending
              ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)] text-white'
              : 'border-line text-ink-2 hover:bg-surface-2 hover:text-[var(--cc-accent)]',
          )}
        >
          <Trash2 size={11} aria-hidden />
          {purgeLabel(pending)}
        </button>
      </div>
    </div>
  );
}

export function TrashView({
  items,
  total,
  loading,
  onLoadMore,
  onRestore,
  onPurge,
  onEmptyTrash,
}: TrashViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 待确认的两类破坏性操作：'empty' = 清空全部，否则是被点了第一次的条目 id。 */
  const [pendingEmpty, setPendingEmpty] = useState(false);
  const [pendingPurge, setPendingPurge] = useState<string | null>(null);

  // 二次确认 3 秒后自动复位：与 Ctrl+Delete / 设置页两个清空按钮同一节奏，
  // 不一致的话用户会以为其中一处坏了。
  useEffect(() => {
    if (!pendingEmpty) return;
    const timer = setTimeout(() => setPendingEmpty(false), EMPTY_TRASH_CONFIRM_TTL_MS);
    return () => clearTimeout(timer);
  }, [pendingEmpty]);

  useEffect(() => {
    if (!pendingPurge) return;
    const timer = setTimeout(() => setPendingPurge(null), EMPTY_TRASH_CONFIRM_TTL_MS);
    return () => clearTimeout(timer);
  }, [pendingPurge]);

  // 列表变短（恢复 / 删掉一条）后滚动位置可能落在空白区，拉回顶部最省事。
  useEffect(() => {
    if (items.length === 0) scrollRef.current?.scrollTo({ top: 0 });
  }, [items.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-tight border-b border-line px-base py-snug">
        <Trash2 size={14} className="text-ink-3" aria-hidden />
        <span className="text-[12px] font-semibold text-ink">{trashTitle(total)}</span>
        <span className="text-[11px] text-ink-3">· 删掉的记录会先留在这里</span>
        <div className="flex-1" />
        {shouldShowEmptyTrash(total) ? (
          <button
            type="button"
            onClick={() => {
              if (pendingEmpty) {
                setPendingEmpty(false);
                onEmptyTrash();
              } else {
                setPendingEmpty(true);
              }
            }}
            className={cn(
              'flex shrink-0 items-center gap-[4px] rounded-button border px-snug py-[4px] text-[11px]',
              pendingEmpty
                ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)] text-white'
                : 'border-line text-ink-2 hover:bg-surface-2',
            )}
          >
            <Trash2 size={12} aria-hidden />
            {emptyTrashLabel(pendingEmpty)}
          </button>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="cc-scroll flex-1 overflow-y-auto px-base py-snug"
        onScroll={(event) => {
          const el = event.currentTarget;
          const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (distanceToBottom < LOAD_MORE_THRESHOLD_PX) onLoadMore();
        }}
      >
        {isTrashEmpty(items.length, loading) ? (
          // 视觉复用 EmptyState；它的话术按 KindFilter 取、答不了"我刚删的东西呢"，
          // 所以下面补一句回收站自己的说明（见 EMPTY_TRASH_HINT 的注释）。
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <EmptyState kind="all" />
            </div>
            <p className="pb-base text-center text-[12px] leading-[1.7] text-ink-3">{EMPTY_TRASH_HINT}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-tight">
            {items.map((item) => (
              <TrashCard
                key={item.id}
                item={item}
                pending={pendingPurge === item.id}
                onRestore={(id) => {
                  setPendingPurge(null);
                  onRestore(id);
                }}
                onPurge={(id) => {
                  if (pendingPurge === id) {
                    setPendingPurge(null);
                    onPurge(id);
                  } else {
                    setPendingPurge(id);
                  }
                }}
              />
            ))}
            {loading ? (
              <p className="py-snug text-center text-[11px] text-ink-3">正在加载更多…</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
