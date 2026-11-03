import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, FolderPlus, Plus, Sparkles, Tag, X } from 'lucide-react';
import { useClipStore } from '../state/store';
import { sanitizeTag, suggestFolder, suggestTags } from '../logic/organize';
import { cn } from './util';
import {
  folderMoveTargets,
  folderPathLabel,
  itemTagsOf,
  tagCandidates,
  toggleTag,
} from './organizeView';

/**
 * 单条记录的整理弹窗（v1.0.0 ⑥）。
 *
 * 两个区各自独立生效：
 *  - 标签区是**草稿**（点 chip 只改本地选中集合），底部「保存」才一次性 setItemTags ——
 *    标签是多选，点一下就落库会产生一串 IPC，撤销还得再点回去。
 *  - 文件夹区是**即时生效**（点一行就 setItemFolder 并关窗）：它是单选，
 *    用户点的那一刻意图就完整了，再要求确认一次纯属多一步。
 *
 * AI 起标签（v1.0.0 ⑥ 可选项）同样只进草稿：模型给的词和本地候选、手输的标签一样，
 * 都要用户点头才写库 —— ★ 让模型直接 setItemTags 会绕过这一层确认，
 * 用户还没看清就多出几个标签，且没有一步能撤回。
 *
 * 遮罩与卡片布局沿用 ContextMenuView / TextViewer 的既有做法（portal + cc-no-drag + cc-scrim）。
 */
export interface OrganizeItemDialogProps {
  itemId: string;
  onClose: () => void;
}

const INPUT_CLASS =
  'w-full rounded-input border border-line bg-surface px-snug py-[5px] text-[12px] text-ink outline-none focus:border-[var(--cc-border-strong)]';

export function OrganizeItemDialog({ itemId, onClose }: OrganizeItemDialogProps): JSX.Element | null {
  const item = useClipStore((s) => s.items.find((i) => i.id === itemId));
  const folders = useClipStore((s) => s.folders);
  const knownTags = useClipStore((s) => s.knownTags);
  const setItemTags = useClipStore((s) => s.setItemTags);
  const setItemFolder = useClipStore((s) => s.setItemFolder);
  const aiProviders = useClipStore((s) => s.aiProviders);
  const suggestTagsByAi = useClipStore((s) => s.suggestTagsByAi);
  const createFolder = useClipStore((s) => s.createFolder);

  const [selected, setSelected] = useState<string[]>(() => itemTagsOf(item));
  const [draftTag, setDraftTag] = useState('');
  const [aiTagging, setAiTagging] = useState(false);
  /** AI 空手而归时的提示文案；'' = 不显示。 */
  const [aiHint, setAiHint] = useState('');

  // 记录不存在（被删了 / 筛选把它摘掉了）：先关窗，再 return null。
  // ★ 放在 effect 里而不是渲染期直接调 onClose —— 渲染期改父组件的状态会触发
  //   React 的"渲染中更新"警告，而且可能被并发渲染重放多次。
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!item) return null;

  const candidates = tagCandidates(knownTags, selected);
  const targets = folderMoveTargets(folders, null);

  /**
   * ★ 本地规则给出的标签候选（固定词表、零网络、零 AI）。
   * 这套规则此前只有单测在调用，产品里一处没接：用户没配 AI、库里又还没有任何标签时，
   * 弹窗只会说「还没有可选标签」，把已经写好的判定整个晾着（审计 BL-2「标签死代码」）。
   * 这里只补**未被选中**的那些，已选中的仍归 candidates 的高亮态管，避免同一个词出现两次。
   * 和 AI 一样进草稿、要点一下才写上 —— 不替用户点头。
   */
  const ruleTags = suggestTags({
    kind: item.kind,
    text: item.preview ?? '',
    sourceApp: item.sourceApp,
    createdAt: item.createdAt,
  }).filter((tag) => !selected.includes(tag) && !candidates.includes(tag));

  /**
   * ★ 规则建议的一级文件夹名（suggestTags 的同源兄弟，之前同样是只有单测在跑）。
   * 只在记录还没归过类时给：已经在某个文件夹里的记录，用户要的是挪一下，
   * 而不是按内容再开一支重复的树。
   */
  const suggestedFolder = item.folderId
    ? undefined
    : suggestFolder({
        kind: item.kind,
        text: item.preview ?? '',
        sourceApp: item.sourceApp,
        createdAt: item.createdAt,
      });

  /**
   * 顶层同名文件夹。
   * ★ 每次都从 store 现读而不是用上面那个 folders 闭包：createFolder 之后闭包还是旧表，
   *   拿旧表判断"建没建成"会永远判不出来。
   */
  const rootFolderNamed = (name: string) =>
    useClipStore
      .getState()
      .folders.find((f) => f.name === name && (f.parentId ?? null) === null);

  const moveToSuggested = async () => {
    const name = suggestedFolder;
    if (name === undefined) return;
    const existing = rootFolderNamed(name);
    if (existing) {
      void setItemFolder(itemId, existing.id);
      onClose();
      return;
    }
    // createFolder 失败时只 toast、不改 folders 表：这时找不到落点，弹窗留着，
    // 用户看得见"没建成"，比静默关窗然后记录仍然未归类好。
    await createFolder({ name, parentId: null });
    const created = rootFolderNamed(name);
    if (created === undefined) return;
    void setItemFolder(itemId, created.id);
    onClose();
  };

  const addDraftTag = () => {
    const tag = sanitizeTag(draftTag);
    if (tag === '') return;
    setSelected((current) => (current.includes(tag) ? current : [...current, tag]));
    setDraftTag('');
  };

  // 没有配好 Key 的模型时连按钮都不出现：点了必然空手而归，不如直接告诉用户去哪配。
  const hasAiProvider = aiProviders.some((provider) => provider.hasKey);

  const addTagsFromAi = async () => {
    setAiTagging(true);
    setAiHint('');
    try {
      const suggestions = await suggestTagsByAi(itemId);
      // ★ 归一化后再并入：模型偶尔给出带 # 号或超长的词，sanitizeTag 是落库前
      //   唯一一道统一处理，这里先走一遍，草稿里显示的就是最终会写进库的样子。
      const incoming = suggestions.map((tag) => sanitizeTag(tag)).filter((tag) => tag !== '');
      if (incoming.length === 0) {
        setAiHint('AI 没给出建议，可以自己加');
        return;
      }
      setSelected((current) => {
        const next = [...current];
        for (const tag of incoming) if (!next.includes(tag)) next.push(tag);
        return next;
      });
    } finally {
      setAiTagging(false);
    }
  };

  const save = () => {
    void setItemTags(itemId, selected);
    onClose();
  };

  return createPortal(
    <div
      className="cc-no-drag fixed inset-0 z-[70] flex items-center justify-center bg-[var(--cc-scrim)] p-comfortable"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cc-pop flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-panel">
        <header className="flex shrink-0 items-center justify-between gap-snug border-b border-line px-snug py-tight">
          <h2 className="truncate text-[12px] font-medium text-ink-2">整理这条记录</h2>
          <button
            type="button"
            title="关闭（Esc）"
            onClick={onClose}
            className="shrink-0 rounded-full p-micro text-ink-3 transition-colors hover:text-[var(--cc-accent)]"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-snug py-tight">
          <p className="line-clamp-2 break-all text-[11px] leading-[1.6] text-ink-3">
            {item.preview}
          </p>

          <section className="mt-tight">
            <div className="flex items-center gap-[4px]">
              <Tag size={12} className="text-ink-3" aria-hidden />
              <span className="text-[11px] font-semibold text-ink-2">标签</span>
              <span className="text-[10px] text-ink-3">· 可多选</span>
              {hasAiProvider ? (
                <button
                  type="button"
                  onClick={() => void addTagsFromAi()}
                  disabled={aiTagging}
                  className="ml-auto flex shrink-0 items-center gap-[3px] rounded-button border border-line px-snug py-[3px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:opacity-40"
                >
                  <Sparkles size={11} aria-hidden />
                  {aiTagging ? '正在起名…' : '用 AI 起名'}
                </button>
              ) : (
                <span className="ml-auto shrink-0 text-[10px] text-ink-3">
                  在设置里配好 AI 模型后，可以让 AI 起标签
                </span>
              )}
            </div>

            {ruleTags.length === 0 ? null : (
              <div className="mt-tight flex flex-wrap items-center gap-[4px]">
                <span className="shrink-0 text-[10px] text-ink-3">本地规则识别到</span>
                {ruleTags.map((tag) => (
                  <button
                    key={'rule-' + tag}
                    type="button"
                    title="按内容规则判定，点一下加入"
                    onClick={() => setSelected((current) => toggleTag(current, tag))}
                    className="rounded-button border border-dashed border-line px-snug py-[3px] text-[11px] text-ink-2 hover:bg-surface-2"
                  >
                    + {tag}
                  </button>
                ))}
              </div>
            )}

            <div className="mt-tight flex flex-wrap gap-[4px]">
              {candidates.length === 0 && ruleTags.length === 0 ? (
                <span className="text-[11px] text-ink-3">还没有可选标签，在下面新建一个。</span>
              ) : (
                candidates.map((tag) => {
                  const active = selected.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setSelected((current) => toggleTag(current, tag))}
                      className={cn(
                        'rounded-button border px-snug py-[3px] text-[11px]',
                        active
                          ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)] text-white'
                          : 'border-line text-ink-2 hover:bg-surface-2',
                      )}
                    >
                      {tag}
                    </button>
                  );
                })
              )}
            </div>

            <div className="mt-tight flex items-center gap-[4px]">
              <input
                value={draftTag}
                onChange={(event) => setDraftTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addDraftTag();
                  }
                }}
                placeholder="新建标签（回车加入）"
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={addDraftTag}
                disabled={sanitizeTag(draftTag) === ''}
                className="flex shrink-0 items-center gap-[3px] rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:opacity-40"
              >
                <Plus size={11} aria-hidden />
                加入
              </button>
            </div>

            {aiHint === '' ? null : <p className="mt-[4px] text-[11px] text-ink-2">{aiHint}</p>}
          </section>

          <section className="mt-comfortable">
            <div className="flex items-center gap-[4px]">
              <FolderOpen size={12} className="text-ink-3" aria-hidden />
              <span className="text-[11px] font-semibold text-ink-2">移动到文件夹</span>
              <span className="text-[10px] text-ink-3">· 点一下就生效</span>
            </div>

            {suggestedFolder === undefined ? null : (
              <button
                type="button"
                onClick={() => void moveToSuggested()}
                className="mt-tight flex w-full items-center gap-[4px] rounded-button border border-dashed border-line px-[6px] py-[4px] text-left text-[12px] text-ink-2 hover:bg-surface-2"
              >
                <FolderPlus size={11} className="shrink-0" aria-hidden />
                {rootFolderNamed(suggestedFolder) ? '移入已有的' : '按内容新建并移入'}「{suggestedFolder}」
              </button>
            )}

            <div className="mt-tight flex flex-col gap-[2px]">
              <button
                type="button"
                onClick={() => {
                  void setItemFolder(itemId, null);
                  onClose();
                }}
                className={cn(
                  'rounded-button px-[6px] py-[4px] text-left text-[12px] hover:bg-surface-2',
                  // 用真值判断而不是 === undefined：folderId 经 IPC 回来可能是 null。
                  !item.folderId ? 'text-[var(--cc-accent)]' : 'text-ink',
                )}
              >
                未归类
              </button>
              {targets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => {
                    void setItemFolder(itemId, target.id);
                    onClose();
                  }}
                  className={cn(
                    'rounded-button px-[6px] py-[4px] text-left text-[12px] hover:bg-surface-2',
                    item.folderId === target.id ? 'text-[var(--cc-accent)]' : 'text-ink',
                  )}
                >
                  {target.label}
                </button>
              ))}
            </div>

            <p className="mt-tight text-[10px] text-ink-3">
              当前：{folderPathLabel(folders, item.folderId ?? null)}
            </p>
          </section>
        </div>

        <footer className="flex shrink-0 items-center gap-tight border-t border-line px-snug py-tight">
          <span className="text-[11px] text-ink-3">已选 {selected.length} 个标签</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            className="shrink-0 rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90"
          >
            保存
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
