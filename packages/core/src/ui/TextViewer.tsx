import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { HIGHLIGHT_MAX_CHARS, guessLanguage, highlightToHtml } from './codeHighlight';
import { editTextActions } from './textEdit';
import { cn } from './util';

export interface TextViewerProps {
  open: boolean;
  title: string;
  text?: string;
  imageUrl?: string;
  loading?: boolean;
  /** 指定语言；不传则按内容猜（猜不出回落 javascript）。 */
  language?: string;
  onCopy?: (text: string) => void;
  /**
   * v1.2 A2：把编辑后的内容交给 App 走 pasteText 通道粘贴。
   * ★ 历史条目不可变——编辑只是浮层里的暂存态，粘贴的是修改后内容，不回写历史；
   *   成功后关浮层由 App 决定（失败保持打开，用户改完可重试）。
   */
  onPasteText?: (text: string) => void;
  /** v1.2 A2：把编辑后的内容存为片段（App 复用片段库的 saveSnippet 流程）；不传则隐藏该按钮。 */
  onSaveAsSnippet?: (text: string) => void;
  onClose: () => void;
}

/**
 * 全文 / 大图浮层。传 imageUrl 就是大图模式，否则按全文模式渲染。
 * 破图用占位文案替代 <img> 的裂图标：缩略图生成失败时裂图标比一句提示更难懂。
 */
export function TextViewer({
  open,
  title,
  text,
  imageUrl,
  loading,
  language,
  onCopy,
  onPasteText,
  onSaveAsSnippet,
  onClose,
}: TextViewerProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // ★ 历史条目不可变——编辑只是浮层里的暂存态：粘贴/存片段用的是「修改后的内容」，
  //   不回写历史条目本体；「取消编辑」直接丢弃暂存。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 每次新开浮层都回到只读态：上一条里没粘出去的暂存不该漏到这一条。
  useEffect(() => {
    if (open) setEditing(false);
  }, [open]);

  if (!open) return null;

  const isImage = typeof imageUrl === 'string' && imageUrl.length > 0;
  const broken = isImage && failedUrl === imageUrl;
  // 浮层里没有搜索态，所以这里不判 term（与卡片不同，不受铁律二影响）。
  const body = text ?? '';
  const hlHtml =
    !isImage && body.length > 0 && body.length <= HIGHLIGHT_MAX_CHARS
      ? highlightToHtml(body, language ?? guessLanguage(body) ?? 'javascript')
      : null;
  // 编辑开关只对文本模式有意义；App 没接任何编辑动作时不出这个按钮（props 可选，别处用法不受影响）。
  const editable = !isImage && !loading && (onPasteText !== undefined || onSaveAsSnippet !== undefined);
  // ★ 进入编辑必须带 body 的原文：hlHtml 只服务只读态展示，绝不能把高亮 HTML 灌进 textarea。
  const enterEdit = () => {
    setDraft(body);
    setEditing(true);
  };

  return createPortal(
    <div
      className="cc-no-drag fixed inset-0 z-[70] flex items-center justify-center bg-[var(--cc-scrim)] p-comfortable"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cc-pop flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-panel">
        <header className="flex shrink-0 items-center justify-between gap-snug border-b border-line px-snug py-tight">
          <h2 className="truncate text-[12px] font-medium text-ink-2">{title}</h2>
          <button
            type="button"
            title="关闭（Esc）"
            onClick={onClose}
            className="shrink-0 rounded-full p-micro text-ink-3 transition-colors hover:text-[var(--cc-accent)]"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div
          className={cn(
            'min-h-0 flex-1 overflow-auto px-snug py-tight',
            // 编辑态让 textarea 撑满剩余空间（与优化面板同款做法），不再用 <pre> 的 max-h。
            editable && editing ? 'flex flex-col' : '',
          )}
        >
          {loading ? (
            <p className="py-comfortable text-center text-[12px] text-ink-3">正在读取…</p>
          ) : isImage ? (
            broken ? (
              <p className="py-comfortable text-center text-[12px] text-ink-3">图片加载失败</p>
            ) : (
              <img
                src={imageUrl}
                alt={title}
                onError={() => setFailedUrl(imageUrl)}
                className="mx-auto max-h-[70vh] max-w-full object-contain"
              />
            )
          ) : editing ? (
            /* 编辑态：等宽字体与只读 <pre> 同一套排版；值是原文，与 hljs 高亮无关。 */
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              className="cc-scroll min-h-[120px] w-full flex-1 resize-none break-words rounded-input border border-line bg-surface px-snug py-tight font-mono text-[12px] leading-[1.7] text-ink outline-none focus:border-[var(--cc-primary)]"
            />
          ) : (
            <pre className="max-h-[60vh] select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.7] text-ink">
              {hlHtml !== null ? (
                <code className="cc-hljs" dangerouslySetInnerHTML={{ __html: hlHtml }} />
              ) : (
                body
              )}
            </pre>
          )}
        </div>

        {!isImage && !loading && (onCopy || editable) ? (
          editing ? (
            /* 编辑态动作条：粘贴是主动作，空内容（纯空白）时禁用；存片段按钮随 props 有无显隐。 */
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-tight border-t border-line px-snug py-tight">
              {onSaveAsSnippet ? (
                <button
                  type="button"
                  disabled={!editTextActions(draft).canPaste}
                  onClick={() => onSaveAsSnippet(draft)}
                  className={cn(
                    'rounded-button border border-line px-snug py-micro text-[12px] text-ink-2 transition-colors',
                    'hover:border-[var(--cc-border-strong)] hover:text-ink',
                    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-2',
                  )}
                >
                  存为片段
                </button>
              ) : null}
              {onCopy ? (
                <button
                  type="button"
                  onClick={() => onCopy(draft)}
                  className={cn(
                    'rounded-button border border-line px-snug py-micro text-[12px] text-ink-2 transition-colors',
                    'hover:border-[var(--cc-border-strong)] hover:text-ink',
                  )}
                >
                  复制
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setEditing(false)}
                className={cn(
                  'rounded-button border border-line px-snug py-micro text-[12px] text-ink-2 transition-colors',
                  'hover:border-[var(--cc-border-strong)] hover:text-ink',
                )}
              >
                取消编辑
              </button>
              <button
                type="button"
                disabled={!editTextActions(draft).canPaste}
                onClick={() => onPasteText?.(draft)}
                className={cn(
                  'rounded-button bg-[var(--cc-primary)] px-snug py-micro text-[12px] text-white transition-opacity',
                  'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40',
                )}
              >
                粘贴修改后内容
              </button>
            </footer>
          ) : (
            <footer className="flex shrink-0 justify-end gap-tight border-t border-line px-snug py-tight">
              {onCopy ? (
                <button
                  type="button"
                  onClick={() => onCopy(text ?? '')}
                  className={cn(
                    'rounded-button border border-line px-snug py-micro text-[12px] text-ink-2 transition-colors',
                    'hover:border-[var(--cc-border-strong)] hover:text-ink',
                  )}
                >
                  复制全文
                </button>
              ) : null}
              {editable ? (
                <button
                  type="button"
                  onClick={enterEdit}
                  className={cn(
                    'rounded-button border border-line px-snug py-micro text-[12px] text-ink-2 transition-colors',
                    'hover:border-[var(--cc-border-strong)] hover:text-ink',
                  )}
                >
                  编辑
                </button>
              ) : null}
            </footer>
          )
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
