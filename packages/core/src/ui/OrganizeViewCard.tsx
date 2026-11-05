import { useEffect, useState } from 'react';
import { FolderPlus, MoveRight, Pencil, Tag, Trash2, X } from 'lucide-react';
import { useClipStore, errorText } from '../state/store';
import { cn } from './util';
import { countLabel, folderMoveTargets, folderRows, isOrganizeEmpty, toggleTag } from './organizeView';
import { UNDO_LABEL } from './toastText';
import {
  WIZARD_BATCH_SIZE,
  appliedToastText,
  collectBatch,
  defaultSelection,
  nextBatchOffset,
  wizardRowsOf,
  type WizardBatch,
  type WizardRow,
} from './organizeWizard';

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
  const moveFolder = useClipStore((s) => s.moveFolder);
  const setFolderFilter = useClipStore((s) => s.setFolderFilter);
  const setTagFilter = useClipStore((s) => s.setTagFilter);
  // v1.2 C1 一键整理向导：与既有动作同一渠道——全走 store，组件自己不碰 getPlatform。
  const untaggedCount = useClipStore((s) => s.untaggedCount);
  const loadUntaggedCount = useClipStore((s) => s.loadUntaggedCount);
  const listUntagged = useClipStore((s) => s.listUntagged);
  const applyTagsBulk = useClipStore((s) => s.applyTagsBulk);
  const toast = useClipStore((s) => s.toast);

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  /** 正在挑移动目标的文件夹 id；null = 没有行处于「移动到…」展开态。 */
  const [movingId, setMovingId] = useState<string | null>(null);

  // ---- v1.2 C1 一键整理向导（组件内状态；关闭整理页即随组件卸载失效）----
  const [wizardOpen, setWizardOpen] = useState(false);
  /** 当前批的向导行（未归类条目 + 本地规则建议）。 */
  const [wizardRows, setWizardRows] = useState<WizardRow[]>([]);
  /** 每行的勾选（id → 标签数组）；默认 = 非空建议全勾，用户可逐个点掉。 */
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  /** 当前批的 offset（推进规则见 nextBatchOffset）。 */
  const [wizardOffset, setWizardOffset] = useState(0);
  /** 第几批（展示用，从 1 起）。 */
  const [wizardBatchNo, setWizardBatchNo] = useState(0);
  const [wizardLoading, setWizardLoading] = useState(false);
  /** 拉到空批 = 全部整理完成（不是失败——失败会 toast 且停在当前批）。 */
  const [wizardDone, setWizardDone] = useState(false);
  /** 正在应用一批（防双击连发两批）。 */
  const [applying, setApplying] = useState(false);
  /**
   * 单级撤销快照：最后一次应用的 id → 应用前旧标签。
   * ★ 会话内单级撤销，重启即失效（组件卸载同样失效）；再应用一批会被新快照覆盖。
   */
  const [undoBatch, setUndoBatch] = useState<WizardBatch['undo'] | null>(null);

  // 打开整理页时刷一次文件夹平表：别的窗口可能刚建/删过，列表页那次拉取已经过时了。
  // 未归类计数同理：入口按钮的 N 用它，打开时刷一次，应用/撤销一批后由 store 再刷。
  useEffect(() => {
    void loadFolders();
    void loadUntaggedCount();
  }, [loadFolders, loadUntaggedCount]);

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

  /**
   * 行的父级 id（顶层为 null）。
   * ★ 问 folders 原表而不是 FolderRow：folderRows 只为树的渲染服务，没带 parentId，
   *   在这里补一个字段会把纯函数的返回形状牵进这次的修复里。
   */
  const parentIdOf = (id: string): string | null =>
    folders.find((f) => f.id === id)?.parentId ?? null;

  const submitMove = (id: string, parentId: string | null) => {
    setMovingId(null);
    void moveFolder(id, parentId);
  };

  // ---- v1.2 C1 一键整理向导 ----
  // ★ 范围红线：只做本地规则标签建议（固定词表，零 AI 调用——费用不可控），
  //   不做文件夹自动建议（有风险）。见 organizeWizard.ts 文件头。

  /** 拉一批未归类条目铺成向导行；空批 = 完成态。失败 toast 并停在当前批（不假装整理完）。 */
  const fetchBatch = async (at: number): Promise<void> => {
    setWizardLoading(true);
    try {
      const items = await listUntagged({ limit: WIZARD_BATCH_SIZE, offset: at });
      if (items.length === 0) {
        setWizardDone(true);
        setWizardRows([]);
        setSelections({});
        return;
      }
      const next = wizardRowsOf(items);
      setWizardRows(next);
      setSelections(Object.fromEntries(next.map((row) => [row.id, defaultSelection(row)])));
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setWizardLoading(false);
    }
  };

  const openWizard = () => {
    setWizardOpen(true);
    setWizardOffset(0);
    setWizardBatchNo(1);
    setWizardDone(false);
    setUndoBatch(null);
    void fetchBatch(0);
  };

  const closeWizard = () => {
    setWizardOpen(false);
    setWizardRows([]);
    setSelections({});
    setUndoBatch(null);
    // 应用/撤销可能已经改了未归类集合：回到整理页前把入口按钮的 N 刷一遍。
    void loadUntaggedCount();
  };

  /** 勾选切换（与标签筛选同一语义：点一下加上、再点一下移除）。 */
  const toggleChip = (id: string, tag: string) => {
    setSelections((current) => ({ ...current, [id]: toggleTag(current[id] ?? [], tag) }));
  };

  /**
   * 撤销最后一批：把应用前快照原样喂回 applyTagsBulk（整体替换语义 = 反向即恢复旧标签）。
   * ★ 单级：撤销后快照清空；toast 上的撤销按钮闭包里带着各自的快照，连应用两批时
   *   旧 toast 的撤销只会撤它那一批，不会错拿最新快照。
   */
  const undoLast = async (undo: WizardBatch['undo']): Promise<void> => {
    if (undo.length === 0 || applying) return;
    setApplying(true);
    try {
      const restored = await applyTagsBulk(undo);
      if (restored <= 0) return; // 失败已在 store 里 toast；快照留着还能再试
      setUndoBatch(null);
      toast('已撤销 ' + restored + ' 条', 'ok');
      // 撤销的条目回到未归类集合前部：重置到第一批重拉，用户可以直接重选。
      setWizardOffset(0);
      setWizardBatchNo(1);
      setWizardDone(false);
      await fetchBatch(0);
    } finally {
      setApplying(false);
    }
  };

  const applyBatch = async (): Promise<void> => {
    if (applying || wizardLoading) return;
    const batch = collectBatch(wizardRows, selections);
    if (batch.entries.length === 0) return; // 按钮已禁用，这里双保险（applied=0 会让向导原地打转）
    setApplying(true);
    try {
      const applied = await applyTagsBulk(batch.entries);
      if (applied <= 0) return; // 失败已在 store 里 toast；不推进、不清快照
      setUndoBatch(batch.undo);
      toast(appliedToastText(applied), 'ok', {
        label: UNDO_LABEL,
        onClick: () => void undoLast(batch.undo),
      });
      // ★ 自动进下一批：offset += 实际应用条数（没勾的行留在原地，本会话不再回头展示）。
      const next = nextBatchOffset(wizardOffset, applied);
      setWizardOffset(next);
      setWizardBatchNo((no) => no + 1);
      await fetchBatch(next);
    } finally {
      setApplying(false);
    }
  };

  /** 本批勾了标签的行数（footer 按钮文案与禁用判定用）。 */
  const applyableCount = collectBatch(wizardRows, selections).entries.length;

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

      {!wizardOpen && isOrganizeEmpty(folders, knownTags) ? (
        <p className="px-base py-comfortable text-center text-[12px] leading-[1.8] text-ink-3">
          还没有文件夹和标签。先在左栏新建一个文件夹，或者给记录打上几个标签，这里就会长出你的分类体系。
        </p>
      ) : null}

      {wizardOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-tight border-b border-line px-base py-snug">
            <button type="button" onClick={closeWizard} className={GHOST_BUTTON_CLASS}>
              返回
            </button>
            <span className="text-[12px] font-semibold text-ink">一键整理</span>
            <span className="text-[11px] text-ink-3">
              · 未归类批量打标签{wizardDone ? '' : ' · 第 ' + wizardBatchNo + ' 批'}
            </span>
            <div className="flex-1" />
            <span className="text-[11px] text-ink-3">本地规则建议 · 点一下选，再点取消</span>
          </div>

          {wizardDone ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-snug px-base py-comfortable">
              <p className="text-center text-[12px] leading-[1.8] text-ink-3">
                没有更多未归类条目了，全部整理完成。
              </p>
              <button type="button" onClick={closeWizard} className={GHOST_BUTTON_CLASS}>
                返回整理
              </button>
            </div>
          ) : (
            <>
              <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-base py-tight">
                {wizardRows.map((row) => {
                  const selected = selections[row.id] ?? [];
                  return (
                    <div
                      key={row.id}
                      className="flex items-center gap-snug border-b border-line py-snug last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={row.preview}>
                        {row.preview === '' ? '（无预览）' : row.preview}
                      </span>
                      {row.suggested.length === 0 ? (
                        <span className="shrink-0 text-[11px] text-ink-3">无建议</span>
                      ) : (
                        <div className="flex shrink-0 flex-wrap justify-end gap-[4px]">
                          {row.suggested.map((tag) => {
                            const on = selected.includes(tag);
                            return (
                              <button
                                key={tag}
                                type="button"
                                onClick={() => toggleChip(row.id, tag)}
                                className={cn(
                                  'rounded-button border px-snug py-[3px] text-[11px]',
                                  on
                                    ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)] text-white'
                                    : 'border-line text-ink-2 hover:bg-surface-2',
                                )}
                              >
                                {tag}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {wizardLoading ? (
                  <p className="py-snug text-center text-[11px] text-ink-3">正在加载未归类条目…</p>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-snug border-t border-line px-base py-snug">
                <span className="text-[11px] text-ink-3">
                  已勾选 {applyableCount} / 本批 {wizardRows.length} 条
                </span>
                <div className="flex-1" />
                {undoBatch !== null ? (
                  <button
                    type="button"
                    onClick={() => void undoLast(undoBatch)}
                    disabled={applying || wizardLoading}
                    title="撤销最后一批（快照只在本次会话内有效）"
                    className={GHOST_BUTTON_CLASS}
                  >
                    撤销
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void applyBatch()}
                  disabled={applying || wizardLoading || applyableCount === 0}
                  title="把勾选的标签应用到本批条目，然后自动进入下一批"
                  className="shrink-0 rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90 disabled:opacity-40"
                >
                  应用本批（{applyableCount} 条）
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
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
              rows.map((row) => {
                // 移动目标只在展开那一行算：每行都算一遍会把 3 层树的每行都跑一次全表校验。
                const moveTargets = movingId === row.id ? folderMoveTargets(folders, row.id) : [];
                const canPromote = movingId === row.id && parentIdOf(row.id) !== null;
                return (
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
                  ) : movingId === row.id ? (
                    // ★ 移动目标行内展开，不做弹窗：候选通常只有几个，弹窗反而盖住树，
                    //   而且用户需要看见自己把这一支拖到了哪儿。校验交给 folderMoveTargets
                    //   （排除自身与子孙、按 MAX_FOLDER_DEPTH 卡超深），点下去不会被主进程拒绝。
                    <div className="flex flex-wrap items-center gap-[4px] py-[2px]">
                      <span className="shrink-0 text-[11px] text-ink-3">移入</span>
                      {canPromote ? (
                        <button
                          type="button"
                          title="提升为顶层文件夹"
                          onClick={() => submitMove(row.id, null)}
                          className={GHOST_BUTTON_CLASS}
                        >
                          顶层
                        </button>
                      ) : null}
                      {moveTargets.map((target) => (
                        <button
                          key={target.id}
                          type="button"
                          onClick={() => submitMove(row.id, target.id)}
                          className={cn(GHOST_BUTTON_CLASS, 'max-w-[150px] truncate')}
                        >
                          {target.label}
                        </button>
                      ))}
                      {!canPromote && moveTargets.length === 0 ? (
                        <span className="text-[11px] text-ink-3">没有可选的目标</span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setMovingId(null)}
                        className="shrink-0 rounded-button px-snug py-[4px] text-[11px] text-ink-3 hover:text-ink"
                      >
                        取消
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
                      {/* 行内动作只在 hover 时显形：常驻三个图标会把 260px 的窄栏挤满。 */}
                      <button
                        type="button"
                        title="移动到其它文件夹"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingId(null);
                          setMovingId(row.id);
                        }}
                        className="hidden shrink-0 text-ink-3 hover:text-ink group-hover:block"
                      >
                        <MoveRight size={11} aria-hidden />
                      </button>
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
                );
              })
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
            {/* v1.2 C1 一键整理入口：N = 未归类计数（count({untagged:true})，挂载时刷新）。
                没有未归类条目时禁用——点进去只会看到完成态，不如不点。 */}
            <button
              type="button"
              onClick={openWizard}
              disabled={untaggedCount <= 0}
              title="给没有标签的记录批量打标签（本地规则建议，不用 AI）"
              className={cn(GHOST_BUTTON_CLASS, tagFilter.length > 0 ? '' : 'ml-auto')}
            >
              整理未归类（{untaggedCount}）
            </button>
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
      )}
    </div>
  );
}