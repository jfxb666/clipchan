import type { KindFilter } from '../types';
import { APP_ICON_URL } from './assets';
import { emptyHintOf } from './badges';
import { firstRunTips } from './firstRun';

/**
 * 空状态（spec §6.1 / §6.3）：用应用图标本身 96px 降饱和（saturate(.35) opacity(.7)）
 * 放在圆角底衬上，不画线稿插画。
 *
 * ★ 首次使用引导只由调用方通过 showFirstRun 决定：本组件不知道库里到底有没有记录，
 *   有记录和没记录的「空」长得一模一样，只有持有列表的调用方分得清。
 *   判定条件写在 firstRun.ts 的 shouldShowFirstRun 里，这里不做二次判断。
 */
export function EmptyState({
  kind = 'all',
  q = '',
  className,
  showFirstRun = false,
}: {
  kind?: KindFilter;
  q?: string;
  className?: string;
  /** 为真时在文案下方补三条上手提示（仅在「全部」页且一条记录都没有时由调用方置真）。 */
  showFirstRun?: boolean;
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
      {showFirstRun ? (
        // 左侧一条竖线做归组：三条提示是并列的，用圆点会跟侧栏的图标抢注意力。
        <ul className="mt-tight flex max-w-[360px] flex-col gap-snug border-l border-line pl-base text-left">
          {firstRunTips().map((tip) => (
            <li key={tip.text}>
              <p className="text-[12px] leading-[1.6] text-ink-2">{tip.text}</p>
              <p className="text-[11px] leading-[1.6] text-ink-3">{tip.hint}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
