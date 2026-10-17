import type { KindFilter } from '../types';
import { APP_ICON_URL } from './assets';
import { emptyHintOf } from './badges';

/**
 * 空状态（spec §6.1 / §6.3）：用应用图标本身 96px 降饱和（saturate(.35) opacity(.7)）
 * 放在圆角底衬上，不画线稿插画。
 */
export function EmptyState({
  kind = 'all',
  q = '',
  className,
}: {
  kind?: KindFilter;
  q?: string;
  className?: string;
}) {
  return (
    <div
      className={
        'flex h-full flex-col items-center justify-center gap-base px-comfortable text-center ' +
        (className ?? '')
      }
    >
      <div className="flex h-[128px] w-[128px] items-center justify-center rounded-card bg-surface-2">
        <img
          src={APP_ICON_URL}
          alt="剪贴板酱"
          width={96}
          height={96}
          className="h-24 w-24 object-contain"
          style={{ filter: 'saturate(.35) opacity(.7)' }}
        />
      </div>
      <p className="max-w-[360px] text-[13px] leading-[1.7] text-ink-2">{emptyHintOf(kind, q)}</p>
    </div>
  );
}
