import { useEffect, useMemo, useState } from 'react';
import { Bookmark, ClipboardPaste, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Snippet, SnippetInput } from '../types';
import { cn } from './util';
import {
  SNIPPET_CONFIRM_TTL_MS,
  SNIPPET_CONTENT_MAX,
  SNIPPET_TITLE_MAX,
  emptySnippetHint,
  snippetLabel,
  snippetMeta,
  snippetPreview,
  sortSnippets,
  validateSnippet,
} from './snippetView';

/**
 * 片段库（v0.6.0 / P1-6）。
 *
 * 与 TrashView 同一个骨架：标题行 + 滚动列表 + 空状态。刻意**不复用 ListPanel** ——
 * 那边绑定了 kind 筛选、搜索高亮、双击粘贴、收藏、右键菜单一整套活跃列表语义，
 * 片段一条都不适用。
 *
 * 新建与编辑共用同一个就地表单（展开在列表顶部），不弹 modal：片段内容常常是
 * 从别处粘来的一大段，modal 里的 textarea 高度受限，就地展开能占满整屏。
 *
 * 所有平台调用都由 App 注入（与 SettingsView / TrashView 一致），组件不碰 getPlatform。
 */
export interface SnippetViewProps {
  snippets: Snippet[];
  loading: boolean;
  onCreate: (input: SnippetInput) => void;
  onUpdate: (input: SnippetInput) => void;
  onRemove: (id: string) => void;
  onUse: (id: string) => void;
}

/** 表单草稿：id 为 null 表示新建（保存时走 onCreate）。 */
interface Draft {
  id: string | null;
  title: string;
  content: string;
}

const GHOST_BUTTON_CLASS =
  'shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2';

const INPUT_CLASS =
  'w-full rounded-input border border-line bg-surface px-snug py-[5px] text-[12px] text-ink outline-none focus:border-[var(--cc-border-strong)]';

/**
 * 就地表单。校验走 snippetView 的纯函数（那边能单测），这里只负责把错误串显示出来。
 * ★ 错误串由本组件持有而不是上抛：输入错了不该触发一次网络请求再回来报错。
 */
function SnippetForm({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: (draft: Draft) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const problem = validateSnippet({ title: draft.title, content: draft.content });
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    onSave(draft);
  };

  return (
    <div className="flex flex-col gap-tight rounded-card border border-[var(--cc-primary)] bg-surface p-snug">
      <input
        // 标题可以留空：snippetLabel 会用内容首行兜底，所以不设 required。
        value={draft.title}
        maxLength={SNIPPET_TITLE_MAX}
        placeholder="标题（可留空，用内容首行代替）"
        onChange={(event) => onChange({ ...draft, title: event.target.value })}
        className={INPUT_CLASS}
      />
      <textarea
        value={draft.content}
        maxLength={SNIPPET_CONTENT_MAX}
        rows={5}
        placeholder="片段内容"
        onChange={(event) => onChange({ ...draft, content: event.target.value })}
        className={cn(INPUT_CLASS, 'cc-scroll resize-y font-mono leading-[1.6]')}
      />
      {error !== null ? <p className="text-[11px] text-[var(--cc-accent)]">{error}</p> : null}
      <div className="flex items-center gap-tight">
        <span className="text-[11px] text-ink-3">
          {draft.content.length} / {SNIPPET_CONTENT_MAX}
        </span>
        <div className="flex-1" />
        <button type="button" onClick={onCancel} className={GHOST_BUTTON_CLASS}>
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90"
        >
          保存
        </button>
      </div>
    </div>
  );
}

/** 单条片段：标题 / 预览 / 元信息 + 使用、编辑、删除三个图标按钮。 */
function SnippetRow({
  snippet,
  pending,
  onUse,
  onEdit,
  onRemove,
}: {
  snippet: Snippet;
  pending: boolean;
  onUse: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-snug rounded-card border border-line bg-surface p-snug shadow-card">
      <div className="mt-[2px] flex h-6 w-6 shrink-0 items-center justify-center rounded-button bg-surface-2 text-ink-3">
        <Bookmark size={12} aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] leading-[1.6] text-ink">{snippetLabel(snippet)}</p>
        <p className="mt-[2px] line-clamp-2 break-all text-[12px] leading-[1.6] text-ink-2">
          {snippetPreview(snippet.content)}
        </p>
        <div className="mt-tight text-[11px] text-ink-3">
          {snippetMeta(snippet, Date.now())}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-[2px]">
        <button
          type="button"
          title="粘贴这条片段"
          onClick={onUse}
          className="shrink-0 rounded-full p-[3px] text-ink-3 opacity-60 transition-colors hover:opacity-100 hover:text-[var(--cc-primary)]"
        >
          <ClipboardPaste size={14} aria-hidden />
        </button>
        <button
          type="button"
          title="编辑"
          onClick={onEdit}
          className="shrink-0 rounded-full p-[3px] text-ink-3 opacity-60 transition-colors hover:opacity-100 hover:text-ink"
        >
          <Pencil size={14} aria-hidden />
        </button>
        <button
          type="button"
          title={pending ? '再点一次就真的删掉' : '删除'}
          onClick={onRemove}
          className={cn(
            'shrink-0 rounded-button px-snug py-[3px] text-[11px] transition-colors',
            pending
              ? 'bg-[var(--cc-accent)] text-white'
              : 'text-ink-3 opacity-60 hover:opacity-100 hover:text-[var(--cc-accent)]',
          )}
        >
          {pending ? '确认删除' : <Trash2 size={14} aria-hidden />}
        </button>
      </div>
    </div>
  );
}

export function SnippetView({
  snippets,
  loading,
  onCreate,
  onUpdate,
  onRemove,
  onUse,
}: SnippetViewProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  // 排序在渲染期算：snippets 是 App 持有的全表，数量级只有几十条，不值得再加一层缓存失效逻辑。
  const ordered = useMemo(() => sortSnippets(snippets), [snippets]);

  // 二次确认 3 秒后自动复位（与回收站 / Ctrl+Delete 同一节奏）。
  useEffect(() => {
    if (pendingRemove === null) return;
    const timer = setTimeout(() => setPendingRemove(null), SNIPPET_CONFIRM_TTL_MS);
    return () => clearTimeout(timer);
  }, [pendingRemove]);

  const save = (next: Draft) => {
    const input: SnippetInput = next.id === null
      ? { title: next.title.trim(), content: next.content }
      : { id: next.id, title: next.title.trim(), content: next.content };
    if (next.id === null) onCreate(input);
    else onUpdate(input);
    setDraft(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-tight border-b border-line px-base py-snug">
        <Bookmark size={14} className="text-ink-3" aria-hidden />
        <span className="text-[12px] font-semibold text-ink">片段</span>
        <span className="text-[11px] text-ink-3">· 共 {snippets.length} 条</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setDraft({ id: null, title: '', content: '' })}
          className="flex shrink-0 items-center gap-[4px] rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
        >
          <Plus size={12} aria-hidden />
          新建片段
        </button>
      </div>

      <div className="cc-scroll flex-1 overflow-y-auto px-base py-snug">
        {draft !== null ? (
          <div className="mb-tight">
            <SnippetForm
              draft={draft}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onSave={save}
            />
          </div>
        ) : null}

        {ordered.length === 0 ? (
          loading ? (
            <p className="py-snug text-center text-[11px] text-ink-3">正在读取片段…</p>
          ) : (
            <p className="py-base text-center text-[12px] leading-[1.7] text-ink-3">
              {emptySnippetHint()}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-tight">
            {ordered.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                pending={pendingRemove === snippet.id}
                onUse={() => onUse(snippet.id)}
                onEdit={() =>
                  setDraft({ id: snippet.id, title: snippet.title, content: snippet.content })
                }
                onRemove={() => {
                  if (pendingRemove === snippet.id) {
                    setPendingRemove(null);
                    // 正在编辑的那条被删掉时收起表单，否则保存会打到一个不存在的 id 上。
                    setDraft((cur) => (cur?.id === snippet.id ? null : cur));
                    onRemove(snippet.id);
                  } else {
                    setPendingRemove(snippet.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
