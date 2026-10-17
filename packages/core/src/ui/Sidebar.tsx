import { Code2, FileText, Image as ImageIcon, Layers, Link2, Settings, Star } from 'lucide-react';
import type { KindFilter } from '../types';
import { cn } from './util';

/** 侧栏导航项（spec §6.3）：数组里只有 6 个分类，底部设置按钮单独渲染。 */
export interface NavItem {
  key: KindFilter;
  label: string;
  icon: typeof Layers;
}

/**
 * 侧栏 6 个分类固定不变（spec §6.4：path / number 不单独建页，归入"文本"）。
 * 文本项对应 text-group（文本 + 路径 + 数字），收藏项对应 favorite。
 */
export const NAV_ITEMS: NavItem[] = [
  { key: 'all', label: '全部', icon: Layers },
  { key: 'text-group', label: '文本', icon: FileText },
  { key: 'image', label: '图片', icon: ImageIcon },
  { key: 'link', label: '链接', icon: Link2 },
  { key: 'code', label: '代码', icon: Code2 },
  { key: 'favorite', label: '收藏', icon: Star },
];

/** 64px 图标导航。 */
export function Sidebar({
  kind,
  view,
  onSelectKind,
  onOpenSettings,
}: {
  kind: KindFilter;
  view: 'list' | 'settings' | 'wordcloud';
  onSelectKind: (kind: KindFilter) => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav className="cc-no-drag flex w-16 shrink-0 flex-col items-center gap-[2px] border-r border-line bg-surface py-snug">
      {NAV_ITEMS.map((nav) => {
        const Icon = nav.icon;
        const active = view === 'list' && kind === nav.key;
        return (
          <button
            key={nav.key}
            type="button"
            title={nav.label}
            onClick={() => onSelectKind(nav.key)}
            className={cn(
              'flex h-[52px] w-[52px] flex-col items-center justify-center gap-[3px] rounded-button transition-colors',
              active
                ? 'bg-primary-soft text-[var(--cc-primary)]'
                : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icon size={17} aria-hidden />
            <span className="text-[10px] leading-none">{nav.label}</span>
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        type="button"
        title="设置"
        onClick={onOpenSettings}
        className={cn(
          'flex h-[52px] w-[52px] flex-col items-center justify-center gap-[3px] rounded-button transition-colors',
          view === 'settings'
            ? 'bg-primary-soft text-[var(--cc-primary)]'
            : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        )}
      >
        <Settings size={17} aria-hidden />
        <span className="text-[10px] leading-none">设置</span>
      </button>
    </nav>
  );
}
