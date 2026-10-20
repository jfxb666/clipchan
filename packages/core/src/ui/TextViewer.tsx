import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { HIGHLIGHT_MAX_CHARS, guessLanguage, highlightToHtml } from './codeHighlight';
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
  onClose,
}: TextViewerProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

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

  if (!open) return null;

  const isImage = typeof imageUrl === 'string' && imageUrl.length > 0;
  const broken = isImage && failedUrl === imageUrl;
  // 浮层里没有搜索态，所以这里不判 term（与卡片不同，不受铁律二影响）。
  const body = text ?? '';
  const hlHtml =
    !isImage && body.length > 0 && body.length <= HIGHLIGHT_MAX_CHARS
      ? highlightToHtml(body, language ?? guessLanguage(body) ?? 'javascript')
      : null;

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

        <div className="min-h-0 flex-1 overflow-auto px-snug py-tight">
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

        {onCopy && !isImage && !loading ? (
          <footer className="flex shrink-0 justify-end border-t border-line px-snug py-tight">
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
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
