import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampMenuPosition, type MenuAction, type MenuItem } from './contextMenu';
import { cn } from './util';

export interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onPick: (action: MenuAction) => void;
  onClose: () => void;
}

/**
 * 菜单尺寸用固定估计值而不是真实测量：位置必须在首帧就定下来，
 * 先渲染再量 DOM 会让菜单闪一下错位。32 行高 + 上下各 6px 内边距与下面的渲染保持一致。
 */
const MENU_WIDTH = 200;
const MENU_ROW_HEIGHT = 32;
const MENU_PADDING_Y = 12;

function firstEnabledIndex(items: MenuItem[]): number {
  return items.findIndex((item) => !item.disabled);
}

export function ContextMenu({ x, y, items, onPick, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(() => firstEnabledIndex(items));

  const position = useMemo(
    () =>
      clampMenuPosition(
        x,
        y,
        { width: MENU_WIDTH, height: items.length * MENU_ROW_HEIGHT + MENU_PADDING_Y },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    [x, y, items.length],
  );

  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const onDismiss = () => onClose();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onDismiss);
    // capture=true：列表内部滚动容器的 scroll 不冒泡到 window，只能靠捕获阶段收到。
    window.addEventListener('scroll', onDismiss, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
    };
  }, [onClose]);

  useEffect(() => {
    const move = (step: number) => {
      setActive((current) => {
        const total = items.length;
        const start = current < 0 ? (step > 0 ? -1 : 0) : current;
        for (let i = 1; i <= total; i += 1) {
          const next = (((start + step * i) % total) + total) % total;
          if (!items[next]?.disabled) return next;
        }
        return current;
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter') {
        const item = items[active];
        if (!item || item.disabled) return;
        event.preventDefault();
        onPick(item.action);
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, items, onPick, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label="条目操作"
      style={{ left: position.x, top: position.y, width: MENU_WIDTH }}
      className="cc-pop cc-no-drag fixed z-[60] rounded-card border border-line bg-surface py-[6px] shadow-panel outline-none"
    >
      {items.map((item, index) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled === true ? true : undefined}
          onMouseEnter={() => {
            if (!item.disabled) setActive(index);
          }}
          onClick={() => {
            if (item.disabled) return;
            onPick(item.action);
            onClose();
          }}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-tight px-snug text-left text-[12px] transition-colors',
            item.danger ? 'text-[var(--cc-accent)]' : 'text-ink',
            item.disabled
              ? 'cursor-not-allowed opacity-40'
              : active === index
                ? 'bg-surface-2'
                : 'bg-transparent',
          )}
        >
          <span className="truncate">{item.label}</span>
          {item.hint ? <span className="shrink-0 text-[11px] text-ink-3">{item.hint}</span> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
