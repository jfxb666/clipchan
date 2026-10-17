/**
 * 今日词云（spec §6.9；计划 Task 9 步骤 ⑤）：应用内视图，不是新窗口。
 *
 * ★ 布局用 core 的 layoutWords（螺旋 + 矩形碰撞），绝对定位摆放：
 *   旧版 legacy/src/WordCloudForm.cs:531 EnsureLayout 的绘制部分被它替换，
 *   旧版的界面（WinForms 自绘窗口）不再沿用。
 * ★ 区域尺寸靠 ResizeObserver 实测，容器为 0 时不排版（避免除以零式的乱放）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { WordCloudData } from '../types';
import { layoutWords } from '../logic/layout';
import { EmptyState } from './EmptyState';

/** 词云绘制区的最小高度（太矮时布局几乎放不下词）。 */
export const MIN_CLOUD_HEIGHT = 240;

export function WordCloudView({
  data,
  loading,
  onExport,
  onRefresh,
}: {
  data: WordCloudData | null;
  loading?: boolean;
  onExport: () => void;
  onRefresh?: () => void;
}) {
  const words = useMemo(() => data?.words ?? [], [data]);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const apply = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [words.length]);

  const placed = useMemo(
    () => (size.w > 0 && size.h > 0 ? layoutWords(words, size) : []),
    [words, size.w, size.h],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-tight border-b border-line px-base py-snug">
        <span className="text-[12px] text-ink-2">
          今日共记录 {data?.totalItems ?? 0} 条
          {words.length > 0 ? ' · ' + words.length + ' 个词' : ''}
        </span>
        <div className="flex-1" />
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
          >
            刷新
          </button>
        ) : null}
        <button
          type="button"
          onClick={onExport}
          className="flex items-center gap-[4px] rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
        >
          <Download size={12} aria-hidden />
          导出 PNG
        </button>
      </div>

      <div
        ref={areaRef}
        data-cc-wordcloud=""
        className="cc-scroll relative min-h-0 flex-1 overflow-hidden"
        style={{ minHeight: MIN_CLOUD_HEIGHT }}
      >
        {words.length === 0 ? (
          <EmptyState kind="all" q="" className={loading ? 'opacity-60' : ''} />
        ) : (
          placed.map((entry) => {
            const maxWeight = words.reduce((acc, cur) => Math.max(acc, cur.weight), 0);
            const ratio = maxWeight > 0 ? entry.weight / maxWeight : 0;
            return (
              <span
                key={entry.word}
                title={entry.weight + ' 次'}
                className="absolute whitespace-nowrap leading-none"
                style={{
                  left: entry.x + 'px',
                  top: entry.y + 'px',
                  fontSize: entry.fontSize + 'px',
                  color: 'var(--cc-primary)',
                  opacity: 0.55 + ratio * 0.45,
                  fontWeight: ratio > 0.6 ? 600 : 400,
                }}
              >
                {entry.word}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}
