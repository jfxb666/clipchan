import { forwardRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, HelpCircle, Search, X } from 'lucide-react';
import { parseSearch } from '../logic/searchQuery';
import { SEARCH_SYNTAX_HINTS, formatSearchErrors, looksLikeAdvancedQuery } from './searchHints';
import { fadeMotion, useRespectReducedMotion } from './motion';
import { cn } from './util';

/**
 * 顶部搜索框（spec §6.3）。
 * 输入交给 store 的 setQuery（300ms 防抖），这里只负责输入体验：
 * ↓ 从搜索框跳到列表。Esc 不在这里管，交给全局键盘表（见 keymap.ts）。
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
    placeholder?: string;
    className?: string;
  }
>(function SearchBar({ value, onChange, onArrowDown, placeholder = '搜索剪贴板…', className }, ref) {
  const errors = useMemo(() => parseSearch(value).errors, [value]);
  const errorText = formatSearchErrors(errors);
  // P3 动效层（e 项）：搜索语法提示（?）进出。动机：用户打出 re:/AND 这类高级语法时
  //   冒出「可查语法」的入口，150ms 淡入把它轻轻带到视线里，输入清掉再淡出——
  //   反馈「提示为什么出现、为什么消失」，不是常驻装饰。★ 该元素跟随查询内容出现
  //   （不是聚焦触发）：搜索框固定 34px 高、没有独立的语法提示条，聚焦时的提示只有
  //   placeholder 与这个 ? 图标；reduced-motion 时退化为直接出现/消失。
  const reduced = useRespectReducedMotion();

  return (
    <div
      className={cn(
        'cc-no-drag flex h-[34px] items-center gap-tight rounded-input border border-line bg-surface px-snug transition-colors focus-within:border-primary',
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
          }
          // ★ Esc 不在这里处理：全局键盘表（keymap.ts）是唯一所有者。
          //   这里以前也接一次 Esc 并调 onEscape，与全局那条叠成"一次按键关两次"（BL-1），
          //   而浮层开着时两条路径还会互相抢关窗顺序。输入框只保留 ↓ 跳出列表这一件事。
        }}
        className="h-full w-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
      />
      {/* 语法提示只走图标 + title：搜索框固定 34px 高，多一行文本会把顶部栏撑高，
          连带主面板与小组件两处布局一起走形。 */}
      <AnimatePresence initial={false}>
        {looksLikeAdvancedQuery(value) ? (
          <motion.button
            key="syntax-hint"
            type="button"
            title={SEARCH_SYNTAX_HINTS.join('\n')}
            aria-label="搜索语法速查"
            className="shrink-0 rounded-full p-[2px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
            {...fadeMotion(reduced)}
          >
            <HelpCircle size={13} aria-hidden />
          </motion.button>
        ) : null}
      </AnimatePresence>
      {errors.length > 0 ? (
        <span className="shrink-0 text-accent" title={errorText}>
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
