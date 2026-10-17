import { Folder, Hash } from 'lucide-react';
import type { Kind } from '../types';
import { badgeOf } from './badges';
import { cn } from './util';

/** 类型徽章（spec §6.4）：六类内容各一枚，path / number 额外挂小图标。 */
export function TypeBadge({ kind, className }: { kind: Kind; className?: string }) {
  const badge = badgeOf(kind);
  return (
    <span
      className={cn(
        'inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center gap-[2px] rounded-full px-[6px] text-[11px] font-semibold leading-none',
        badge.className,
        className,
      )}
      title={kind}
    >
      {badge.icon === 'folder' ? <Folder size={11} strokeWidth={2.4} aria-hidden /> : null}
      {badge.icon === 'hash' ? <Hash size={11} strokeWidth={2.4} aria-hidden /> : null}
      <span>{badge.label}</span>
    </span>
  );
}
