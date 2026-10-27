import { useEffect, useState } from 'react';
import { FolderPlus, Pencil, Tag, Trash2, X } from 'lucide-react';
import { useClipStore } from '../state/store';
import { cn } from './util';
import { countLabel, folderRows, isOrganizeEmpty } from './organizeView';

/**
 * 「整理」整页视图（v1.0.0 ⑥）。
 *
 * 左栏文件夹树 + 右栏标签云。与 TrashView / SnippetView 同一个骨架：标题行 +
 * 两栏滚动区 + 空状态；所有平台调用都走 store 的动作，组件自己不碰 getPlatform。
 *
 * ★ 选中文件夹后立刻 onClose()：用户点文件夹的意图是「看这个文件夹里的记录」，
 *   留在整理页等于让他再点一次返回。标签**不**关页面：标签是 AND 多选，
 *   关掉就没法连点第二个了。
 */
export interface OrganizeViewProps {
  onClose: () => void;
}

const INPUT_CLASS =
  'w-full rounded-input border border-line bg-surface px-snug py-[5px] text-[12px] text-ink outline-none focus:border-[var(--cc-border-strong)]';

const GHOST_BUTTON_CLASS =
  'shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2';

/** 文件夹树的每层缩进像素。 */
const INDENT_PX = 14;

export function OrganizeView({ onClose }: OrganizeViewProps): JSX.Element {
  const folders = useClipStore((s) => s.folders);
  const folderFilter = useClipStore((s) => s.folderFilter);
  const tagFilter = useClipStore((s) => s.tagFilter);
  const knownTags = useClipStore((s) => s.knownTags);
  const loadFolders = useClipStore((s) => s.loadFolders);
  const createFolder = useClipStore((s) => s.createFolder);
  const renameFolder = useClipStore((s) => s.renameFolder);
  const removeFolder = useClipStore((s) => s.removeFolder);
  const setFolderFilter = useClipStore((s) => s.setFolderFilter);
  const setTagFilter = useClipStore((s) => s.setTagFilter);

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // 打开整理页时刷一次文件夹平表：别的窗口可能刚建/删过，列表页那次拉取已经过时了。
  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  const rows = folderRows(folders);
  // 新建的父级默认当前选中项：在「工作 / 文档」里点新建，显然是想在文档下面建。
  const parentForNew = typeof folderFilter === 'string' ? folderFilter : null;

  const submitNew = () => {
    const name = newName.trim();
    if (name === '') return;
    void createFolder({ name, parentId: parentForNew });
    setNewName('');
  };

  const submitRename = (id: string) => {
    const name = editingName.trim();
    setEditingId(null);
    setEditingName('');
    if (name === '') return;
    void renameFolder(id, name);
  };

  const confirmRemove = (id: string, name: string) => {
    // 破坏性操作必须二次确认，且文案要说清后果：删的是文件夹，不是里面的记录。
    const ok = window.confirm(
      '确定删除文件夹「' + name + '」吗？\n里面的记录不会被删除，会回到「未归类」。',
    );
    if (ok) void removeFolder(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-tight border-b border-line px-base py-snug">
        <FolderPlus size={14} className="text-ink-3" aria-hidden />
        <span className="text-[12px] font-semibold text-ink">整理</span>
        <span className="text-[11px] text-ink-3">· 文件夹分类，标签多选</span>
        <div className="flex-1" />
        <button
          type="button"
          title="关闭整理（Esc）"
          onClick={onClose}
          className="shrink-0 rounded-full p-micro text-ink-3 transition-colors hover:text-[var(--cc-accent)]"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {isOrganizeEmpty(folders, knownTags) ? (
        <p className="px-base py-comfortable text-center text-[12px] leading-[1.8] text-ink-3">
          还没有文件夹和标签。先在左栏新建一个文件夹，或者给记录打上几个标签，这里就会长出你的分类体系。
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[260px] shrink-0 flex-col border-r border-line">
          <div className="flex shrink-0 items-center gap-[4px] px-snug pt-snug">
            <button
              type="button"
              onClick={() => {
                setFolderFilter(undefined);
                onClose();
              }}
              className={cn(
                'rounded-button px-snug py-[3px] text-[11px]',
                folderFilter === undefined
                  ? 'bg-[var(--cc-accent)] text-white'
                  : 'text-ink-2 hover:bg-surface-2',
              )}
            >
              全部记录
            </button>
            <button
              type="button"
              onClick={() => {
                setFolderFilter(null);
                onClose();
              }}
              className={cn(
                'rounded-button px-snug py-[3px] text-[11px]',
                folderFilter === null
                  ? 'bg-[var(--cc-accent)] text-white'
                  : 'text-ink-2 hover:bg-surface-2',
              )}
            >
              未归类
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-[4px] px-snug py-tight">
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitNew();
              }}
              placeholder={parentForNew === null ? '新建文件夹' : '新建子文件夹'}
              className={INPUT_CLASS}
            />
            <button
              type="button"
              onClick={submitNew}
              disabled={newName.trim() === ''}
              className="shrink-0 rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90 disabled:opacity-40"
            >
              新建
            </button>
          </div>

          <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-snug pb-snug">
            {rows.length === 0 ? (
              <p className="py-snug text-center text-[11px] text-ink-3">还没有文件夹</p>
            ) : (
              rows.map((row) => (
                <div
                  key={row.id}
                  // ★ 缩进用内联 style 而不是运行时拼出来的 Tailwind 类名：Tailwind 是静态
                  //   扫描源码的，拼出来的类名不会被生成，缩进会静默失效。
                  style={{ paddingLeft: row.depth * INDENT_PX }}
                  className="group"
                >
                  {editingId === row.id ? (
                    <div className="flex items-center gap-[4px] py-[2px]">
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') submitRename(row.id);
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                        className={INPUT_CLASS}
                      />
                      <button
                        type="button"
                        onClick={() => submitRename(row.id)}
                        className={GHOST_BUTTON_CLASS}
                      >
                        确定
                      </button>
                    </div>
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setFolderFilter(row.id);
                        onClose();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setFolderFilter(row.id);
                          onClose();
                        }
                      }}
                      className={cn(
                        'flex cursor-pointer items-center gap-tight rounded-button px-[6px] py-[3px] text-[12px] hover:bg-surface-2',
                        folderFilter === row.id
                          ? 'bg-surface-2 text-[var(--cc-accent)]'
                          : 'text-ink',
                      )}
                    >
                      <span className="truncate">{row.name}</span>
                      <div className="flex-1" />
                      <span className="shrink-0 text-[10px] text-ink-3">
                        {countLabel(row.totalCount)}
                      </span>
                      {/* 行内动作只在 hover 时显形：常驻两个图标会把 260px 的窄栏挤满。 */}
                      <button
                        type="button"
                        title="重命名"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingId(row.id);
                          setEditingName(row.name);
                        }}
                        className="hidden shrink-0 text-ink-3 hover:text-ink group-hover:block"
                      >
                        <Pencil size={11} aria-hidden />
                      </button>
                      <button
                        type="button"
                        title="删除文件夹（里面的记录会回到未归类）"
                        onClick={(event) => {
                          event.stopPropagation();
                          confirmRemove(row.id, row.name);
                        }}
                        className="hidden shrink-0 text-ink-3 hover:text-[var(--cc-accent)] group-hover:block"
                      >
                        <Trash2 size={11} aria-hidden />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-tight px-base pt-snug">
            <Tag size={13} className="text-ink-3" aria-hidden />
            <span className="text-[11px] font-semibold text-ink-2">标签</span>
            {tagFilter.length > 0 ? (
              <button
                type="button"
                onClick={() => setTagFilter([])}
                className="ml-auto text-[11px] text-ink-3 hover:text-[var(--cc-accent)]"
              >
                清空筛选
              </button>
            ) : null}
          </div>

          {tagFilter.length > 0 ? (
            <div className="flex shrink-0 flex-wrap items-center gap-[4px] px-base py-tight">
              {tagFilter.map((tag) => (
                <button
                  key={'sel-' + tag}
                  type="button"
                  onClick={() => setTagFilter(tagFilter.filter((t) => t !== tag))}
                  title="取消这个标签"
                  className="flex items-center gap-[3px] rounded-button border border-[var(--cc-accent)] bg-[var(--cc-accent)] px-snug py-[3px] text-[11px] text-white"
                >
                  {tag}
                  <X size={10} aria-hidden />
                </button>
              ))}
            </div>
          ) : null}

          <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-base py-tight">
            {knownTags.length === 0 ? (
              <p className="py-snug text-center text-[11px] text-ink-3">
                还没有标签。给记录打上标签后，这里会列出全部标签。
              </p>
            ) : (
              <div className="flex flex-wrap gap-[6px]">
                {knownTags.map((entry) => {
                  const active = tagFilter.includes(entry.tag);
                  return (
                    <button
                      key={entry.tag}
                      type="button"
                      // 标签是 AND 多选：点一下加进筛选，再点一下移除。
                      onClick={() =>
                        setTagFilter(
                          active
                            ? tagFilter.filter((t) => t !== entry.tag)
                            : [...tagFilter, entry.tag],
                        )
                      }
                      className={cn(
                        'flex items-center gap-[4px] rounded-button border px-snug py-[4px] text-[11px]',
                        active
                          ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)] text-white'
                          : 'border-line text-ink-2 hover:bg-surface-2',
                      )}
                    >
                      <span>{entry.tag}</span>
                      <span className={active ? 'text-white/70' : 'text-ink-3'}>{entry.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}