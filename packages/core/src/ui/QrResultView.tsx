import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { qrLooksLikeUrl, qrMessageOf, type QrStatus } from './qrView';

export interface QrResultViewProps {
  open: boolean;
  status: QrStatus;
  /** 识别结果原文；没识别到二维码时是空串（主进程约定不抛异常）。 */
  result: string;
  /** 已翻成中文的失败原因。 */
  error: string | null;
  onCopy: (text: string) => void;
  onSaveAsItem: (text: string) => void;
  onClose: () => void;
}

const GHOST_BUTTON_CLASS =
  'rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * 二维码结果浮层。与 OcrResultView 同范式：平台能力全部由 App 注入，
 * 组件不 getPlatform()——识别在主进程（铁律三），渲染层只负责显示与回调。
 *
 * ★ 与 OCR 面板最大的差别：二维码没有语言包、没有进度、没有二次确认，
 *   打开即识别，所以这里只有一个结果区，不再有 status.ready 那一整套分支。
 */
export function QrResultView({
  open,
  status,
  result,
  error,
  onCopy,
  onSaveAsItem,
  onClose,
}: QrResultViewProps) {
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

  // ★ 只有 found 才算"有东西可以拿走"：loading / empty / error 下亮着按钮，
  //   用户点了只会复制一段空串，比按钮灰着更让人困惑。
  const ready = status === 'found';
  const message = qrMessageOf(status);
  const isUrl = ready && qrLooksLikeUrl(result);

  return createPortal(
    <div
      className="cc-no-drag fixed inset-0 z-[70] flex items-center justify-center bg-[var(--cc-scrim)] p-comfortable"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cc-pop flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-panel">
        <header className="flex shrink-0 items-center justify-between gap-snug border-b border-line px-snug py-tight">
          <h2 className="truncate text-[12px] font-medium text-ink-2">识别二维码</h2>
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
          {message !== '' ? (
            <p className="py-comfortable text-center text-[12px] text-ink-3">{message}</p>
          ) : null}

          {/* 失败原因单独一行：主进程抛出来的原文比一句「识别失败」有用得多。 */}
          {status === 'error' && error !== null ? (
            <p className="mb-tight rounded-input bg-[var(--cc-accent-soft)] px-snug py-tight text-[12px] leading-[1.6] text-[var(--cc-accent)]">
              {error}
            </p>
          ) : null}

          {ready ? (
            <div className="flex flex-col gap-tight">
              {isUrl ? (
                // 只是个提示，不提供"打开"：渲染层没有开外链的通道，
                // 摆了按钮却点不开比不摆更糟（用户可以复制出去自己开）。
                <p className="text-[11px] text-ink-3" title="可复制后到浏览器打开">
                  这是一个链接
                </p>
              ) : null}
              <pre className="cc-scroll max-h-[50vh] overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-[1.7] text-ink select-text">
                {result}
              </pre>
            </div>
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center gap-snug border-t border-line px-snug py-tight">
          <button
            type="button"
            className={GHOST_BUTTON_CLASS}
            disabled={!ready}
            onClick={() => onCopy(result)}
          >
            复制
          </button>
          <button
            type="button"
            className={GHOST_BUTTON_CLASS}
            disabled={!ready}
            onClick={() => onSaveAsItem(result)}
          >
            存为文本记录
          </button>
          <button type="button" className={GHOST_BUTTON_CLASS} onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
