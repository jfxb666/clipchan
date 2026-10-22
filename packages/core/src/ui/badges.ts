import type { Kind, KindFilter } from '../types';

/**
 * 类型徽章与空状态文案（spec §6.4）。
 * 徽章只有 6 类，侧栏仍是 6 个页面：路径 / 数字都归入"文本"页，
 * 所以它们同时带一个"归属页"（filterKind）。
 */

/** 徽章上除了文字还要挂的小图标；没有则为 null。 */
export type BadgeIcon = 'folder' | 'hash' | null;

export interface Badge {
  /** 徽章上的字面量，逐字对齐 spec §6.4。 */
  label: string;
  /** Tailwind 类：底色取 badge-*-bg 令牌，前景取语义色令牌。 */
  className: string;
  /** path → 文件夹图标；number → 井号图标；其余无。 */
  icon: BadgeIcon;
}

/** spec §6.4 的六类徽章，逐字对应，不要改字面量。 */
const BADGES: Record<Kind, Badge> = {
  text: {
    label: 'T',
    className: 'bg-[var(--cc-badge-text-bg)] text-[var(--cc-warm)]',
    icon: null,
  },
  link: {
    label: 'Link',
    className: 'bg-[var(--cc-badge-link-bg)] text-[var(--cc-primary)]',
    icon: null,
  },
  code: {
    label: '</>',
    className: 'bg-[var(--cc-badge-code-bg)] text-[var(--cc-accent)] font-mono',
    icon: null,
  },
  path: {
    label: 'T',
    className: 'bg-[var(--cc-badge-path-bg)] text-[var(--cc-warm)]',
    icon: 'folder',
  },
  number: {
    label: 'T',
    className: 'bg-[var(--cc-badge-number-bg)] text-[var(--cc-warm)]',
    icon: 'hash',
  },
  image: {
    label: 'Img',
    className: 'bg-[var(--cc-badge-image-bg)] text-[var(--cc-pink)]',
    icon: null,
  },
  files: {
    label: 'File',
    className: 'bg-[var(--cc-badge-path-bg)] text-[var(--cc-warm)]',
    icon: 'folder',
  },
};

/** 取某个内容类别的徽章描述。 */
export function badgeOf(kind: Kind): Badge {
  return BADGES[kind];
}

/** 某个内容类别归属哪个侧栏页面（path / number 归入 text-group）。 */
export function filterKindOf(kind: Kind): KindFilter {
  return kind === 'path' || kind === 'number' ? 'text-group' : kind;
}

/**
 * 空状态文案（spec §6.3 空状态图标 + 文案）。
 * 5 个内容分组 + 收藏共 6 组，每组在"有搜索词 / 无搜索词"下各一句，
 * 全部互不相同，避免用户看到千篇一律的"空空如也"。
 */
const EMPTY_NO_QUERY: Record<string, string> = {
  all: '口袋还是空的，复制点什么试试',
  'text-group': '还没有文本记录，复制一段文字看看',
  image: '还没有图片记录，截个图试试',
  files: '还没有文件记录，复制一个文件试试',
  link: '还没有链接记录，复制一个网址试试',
  code: '还没有代码记录，复制一段代码试试',
  favorite: '还没有收藏，点卡片右下角的星标就能收藏',
};

const EMPTY_WITH_QUERY: Record<string, (q: string) => string> = {
  all: (q) => '没有找到包含「' + q + '」的记录',
  'text-group': (q) => '没有找到包含「' + q + '」的文本',
  image: (q) => '没有找到匹配「' + q + '」的图片',
  files: (q) => '没有找到匹配「' + q + '」的文件',
  link: (q) => '没有找到包含「' + q + '」的链接',
  code: (q) => '没有找到包含「' + q + '」的代码',
  favorite: (q) => '收藏里没有匹配「' + q + '」的记录',
};

/** 空状态提示语：kind 为侧栏页面，q 为当前搜索词。 */
export function emptyHintOf(kind: KindFilter, q = ''): string {
  const key = kind in EMPTY_NO_QUERY ? kind : 'all';
  const keyword = q.trim();
  if (keyword) {
    const withQuery = EMPTY_WITH_QUERY[key];
    if (withQuery) return withQuery(keyword);
  }
  return EMPTY_NO_QUERY[key] ?? EMPTY_NO_QUERY.all ?? '';
}
