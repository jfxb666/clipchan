import {
  Bookmark,
  Code2,
  FileText,
  FolderTree,
  Image as ImageIcon,
  Layers,
  Link2,
  Settings,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import type { KindFilter } from '../types';
import type { View } from '../state/store';
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
 *
 * ★ 回收站**不进这个数组**：NavItem.key 的类型是 KindFilter（分类筛选），
 *   而回收站是一个独立视图、也不参与分类筛选。塞进来会逼着 KindFilter 加一个
 *   永远查不到数据的 'trash' 分类。它渲染成数组之外的独立按钮。
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
  onOpenTrash,
  onOpenSettings,
  onOpenOptimize,
  onOpenSnippets,
  onOpenOrganize,
}: {
  kind: KindFilter;
  view: View;
  onSelectKind: (kind: KindFilter) => void;
  onOpenTrash: () => void;
  onOpenSettings: () => void;
  /** 传入才渲染常驻「优化」入口；不传时侧栏与旧版完全一致。 */
  onOpenOptimize?: () => void;
  /** 传入才渲染「片段」入口（v0.6.0 片段库）；不传时侧栏与旧版完全一致。 */
  onOpenSnippets?: () => void;
  /** 传入才渲染「整理」入口（v1.0.0 ⑥ 标签/文件夹）；不传时侧栏与旧版完全一致。 */
  onOpenOrganize?: () => void;
}) {
  /** 分类项、优化入口与底部两个入口共用同一套外观，避免各处各写一遍尺寸与配色。 */
  const itemClass = (active: boolean): string =>
    cn(
      'flex h-[52px] w-[52px] flex-col items-center justify-center gap-[3px] rounded-button transition-colors',
      active
        ? 'bg-primary-soft text-[var(--cc-primary)]'
        : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
    );

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
            className={itemClass(active)}
          >
            <Icon size={17} aria-hidden />
            <span className="text-[10px] leading-none">{nav.label}</span>
          </button>
        );
      })}
      {/* ★ 优化入口同样不进 NAV_ITEMS：它打开优化面板（View = 'optimize'），不参与分类筛选。 */}
      {onOpenOptimize ? (
        <button type="button" onClick={onOpenOptimize} className={itemClass(false)} title="提示词优化">
          <Sparkles size={17} aria-hidden />
          <span className="text-[10px] leading-none">优化</span>
        </button>
      ) : null}
      {/* 片段库同理：View = 'snippets'，是独立视图而非分类筛选。 */}
      {onOpenSnippets ? (
        <button
          type="button"
          onClick={onOpenSnippets}
          className={itemClass(view === 'snippets')}
          title="片段库"
        >
          <Bookmark size={17} aria-hidden />
          <span className="text-[10px] leading-none">片段</span>
        </button>
      ) : null}
      {/* 整理同理：View = 'organize'，是独立视图而非分类筛选。
          图标用 FolderTree 而不是 Tags：整理视图里文件夹是主导航（标签只是记录上的属性），
          树形图标能同时暗示"标签 + 文件夹"这层结构。 */}
      {onOpenOrganize ? (
        <button
          type="button"
          onClick={onOpenOrganize}
          className={itemClass(view === 'organize')}
          title="智能整理"
        >
          <FolderTree size={17} aria-hidden />
          <span className="text-[10px] leading-none">整理</span>
        </button>
      ) : null}
      <div className="flex-1" />
      {/* 回收站紧贴设置上方：两者都是"工具型"入口，放在分类之后、底部收口。 */}
      <button type="button" title="回收站" onClick={onOpenTrash} className={itemClass(view === 'trash')}>
        <Trash2 size={17} aria-hidden />
        <span className="text-[10px] leading-none">回收站</span>
      </button>
      <button type="button" title="设置" onClick={onOpenSettings} className={itemClass(view === 'settings')}>
        <Settings size={17} aria-hidden />
        <span className="text-[10px] leading-none">设置</span>
      </button>
    </nav>
  );
}
