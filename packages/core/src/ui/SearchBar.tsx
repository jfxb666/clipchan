import { forwardRef, useMemo } from 'react';
import { AlertTriangle, HelpCircle, Search, X } from 'lucide-react';
import { parseSearch } from '../logic/searchQuery';
import { SEARCH_SYNTAX_HINTS, formatSearchErrors, looksLikeAdvancedQuery } from './searchHints';
import { cn } from './util';

/**
 * 顶部搜索框（spec §6.3）。
 * 输入交给 store 的 setQuery（300ms 防抖），这里只负责输入体验：
 * ↓ 从搜索框跳到列表、Esc 交给外层处理（隐藏面板）。
 * 用 forwardRef 把真实 input 暴露给 App，Ctrl+F 才能直接聚焦。
 *
 * 语法反馈也在这里做：解析器不抛异常（边打边搜时中间态随时非法），
 * 只把原因写进 errors，所以由输入框自己再解析一次拿到 errors 显示，
 * 这样不必给 SearchBar 加必填 props，App/WidgetView 的调用点一行都不用改。
 */
export const SearchBar = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    onArrowDown?: () => void;
    onEscape?: () => void;
    placeholder?: string;
    className?: string;
  }
>(function SearchBar(
  { value, onChange, onArrowDown, onEscape, placeholder = '搜索剪贴板…', className },
  ref,
) {
  const errors = useMemo(() => parseSearch(value).errors, [value]);
  const errorText = formatSearchErrors(errors);

  return (
    <div
      className={cn(
        'cc-no-drag flex h-[34px] items-center gap-tight rounded-input border border-line bg-surface px-snug transition-colors focus-within:border-[var(--cc-border-strong)]',
        className,
      )}
    >
      <Search size={14} className="shrink-0 text-ink-3" aria-hidden />
      <input
        ref={ref}
        data-cc-search=""
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            onArrowDown?.();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onEscape?.();
          }
        }}
        className="h-full w-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
      />
      {/* 语法提示只走图标 + title：搜索框固定 34px 高，多一行文本会把顶部栏撑高，
          连带主面板与小组件两处布局一起走形。 */}
      {looksLikeAdvancedQuery(value) ? (
        <button
          type="button"
          title={SEARCH_SYNTAX_HINTS.join('\n')}
          aria-label="搜索语法速查"
          className="shrink-0 rounded-full p-[2px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        >
          <HelpCircle size={13} aria-hidden />
        </button>
      ) : null}
      {errors.length > 0 ? (
        <span className="shrink-0 text-[var(--cc-accent)]" title={errorText}>
          <AlertTriangle size={13} aria-hidden />
        </span>
      ) : null}
      {value ? (
        <button
          type="button"
          title="清空搜索"
          onClick={() => onChange('')}
          className="shrink-0 rounded-full p-[2px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}
    </div>
  );
});
