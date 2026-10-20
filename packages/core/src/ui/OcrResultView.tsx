import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { OcrProgress, OcrResult, OcrStatus } from '../types';
import { canSaveAsItem, ocrErrorText, ocrProgressText, ocrStatusText } from './ocrView';

export interface OcrResultViewProps {
  open: boolean;
  /**
   * 正在识别的那条记录。组件本身不消费它——父层用它决定弹哪条、
   * 并在换条目时重建浮层；留在这里是为了让 props 自解释。
   */
  itemId: string;
  /** 语言包就绪状态；null 表示还在问主进程。 */
  status: OcrStatus | null;
  /** 下载 / 识别的实时进度；没有在途任务时为 null。 */
  progress: OcrProgress | null;
  result: OcrResult | null;
  /** 已翻成中文的失败原因。 */
  error: string | null;
  loading: boolean;
  onDownload: () => void;
  onRecognize: () => void;
  onSaveAsItem: (text: string) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}

const GHOST_BUTTON_CLASS =
  'rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60';
const PRIMARY_BUTTON_CLASS =
  'rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * OCR 结果浮层。与 TextViewer / OptimizeViewCard 同风格：平台能力全部由 App 注入，
 * 组件不 getPlatform()——识别与下载都在主进程（铁律三），渲染层只负责显示与回调。
 */
export function OcrResultView({
  open,
  status,
  progress,
  result,
  error,
  loading,
  onDownload,
  onRecognize,
  onSaveAsItem,
  onCopy,
  onClose,
}: OcrResultViewProps) {
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

  const ready = status?.ready === true;
  const text = result?.text ?? '';
  const canSave = result !== null && canSaveAsItem(result);
  // 下载阶段才有百分比；识别阶段的 ratio 无意义，只显示一句「正在识别…」。
  const downloading = loading && progress !== null && progress.phase === 'download';
  const ratio = downloading && progress !== null && progress.ratio >= 0 ? progress.ratio : null;

  return createPortal(
    <div
      className="cc-no-drag fixed inset-0 z-[70] flex items-center justify-center bg-[var(--cc-scrim)] p-comfortable"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cc-pop flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-panel">
        <header className="flex shrink-0 items-center justify-between gap-snug border-b border-line px-snug py-tight">
          <h2 className="truncate text-[12px] font-medium text-ink-2">识别结果</h2>
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
          {/* 失败原因优先于一切：未就绪时的下载按钮再显眼，也不该盖住「为什么失败」。 */}
          {error !== null ? (
            <p className="mb-tight rounded-input bg-[var(--cc-accent-soft)] px-snug py-tight text-[12px] leading-[1.6] text-[var(--cc-accent)]">
              {ocrErrorText(error)}
            </p>
          ) : null}

          {status !== null && !ready ? (
            <div className="flex flex-col gap-snug py-comfortable">
              <p className="text-center text-[12px] text-ink-2">{ocrStatusText(status)}</p>
              <div className="flex justify-center">
                <button
                  type="button"
                  className={PRIMARY_BUTTON_CLASS}
                  disabled={loading}
                  onClick={onDownload}
                >
                  {downloading ? '下载中…' : '下载语言包'}
                </button>
              </div>
            </div>
          ) : null}

          {downloading ? (
            <div className="flex flex-col gap-tight">
              <p className="text-[11px] text-ink-3">{progress !== null ? ocrProgressText(progress) : '正在下载…'}</p>
              {ratio !== null ? (
                <div className="h-[4px] w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-[var(--cc-primary)]" style={{ width: Math.round(ratio * 100) + '%' }} />
                </div>
              ) : null}
            </div>
          ) : null}

          {ready && loading && !downloading ? (
            <p className="py-comfortable text-center text-[12px] text-ink-3">
              {progress !== null ? ocrProgressText(progress) : '识别中…'}
            </p>
          ) : null}

          {ready && !loading && result === null ? (
            <div className="flex flex-col gap-snug py-comfortable">
              <p className="text-center text-[12px] text-ink-2">这张图还没识别过</p>
              <div className="flex justify-center">
                <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={onRecognize}>
                  开始识别
                </button>
              </div>
            </div>
          ) : null}

          {result !== null && !loading ? (
            text.trim() === '' ? (
              <p className="py-comfortable text-center text-[12px] text-ink-3">没有识别到文字</p>
            ) : (
              <pre className="cc-scroll max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.7] text-ink select-text">
                {text}
              </pre>
            )
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center gap-snug border-t border-line px-snug py-tight">
          {/* 复制只看有没有结果；「存为一条新记录」还要看是不是全空白（存空记录没有意义）。 */}
          <button
            type="button"
            className={GHOST_BUTTON_CLASS}
            disabled={result === null}
            onClick={() => onCopy(text)}
          >
            复制
          </button>
          {/* 全空白时禁用：存进去只会是一条空记录，不如让用户当场看见按钮是灰的。 */}
          <button
            type="button"
            className={GHOST_BUTTON_CLASS}
            disabled={!canSave}
            onClick={() => onSaveAsItem(text)}
          >
            存为一条新记录
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
