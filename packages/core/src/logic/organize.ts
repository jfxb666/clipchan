/**
 * 本地智能整理规则（纯逻辑，零网络 / 零 AI / 零 IO）。
 *
 * 两件事：
 *  1. suggestTags   —— 给一条记录打标签（固定词表、确定性、可解释）。
 *  2. suggestFolder —— 建议一级文件夹名，配合下面的多级文件夹纯逻辑（folderPathOf /
 *     canMoveFolder / buildFolderTree）支撑"多级文件夹"的界面与移动校验。
 *
 * 这里只放规则与树运算，不碰数据库、不碰 Electron、不碰 React。
 * AI 语义标签是后续可选项，本文件不依赖它。
 */

import { classify } from './classify';

/** 一条记录的整理输入（只要这几样，别引入数据库类型）。 */
export interface OrganizeInput {
  /** 'text' | 'link' | 'code' | 'path' | 'number' | 'image' | 'files'（与 core 的 Kind 一致，但这里放宽成 string 更健壮） */
  kind: string;
  /** 正文；图片/文件记录可为空串。 */
  text: string;
  /** 来源 exe 名，如 'Code.exe'；未知为 undefined。 */
  sourceApp?: string;
  /** 创建时间（毫秒）。 */
  createdAt: number;
}

/** 一条记录最多给几个标签。★ 界面标签位只有三个，第 4 个开始挤成一团且无信息增量。 */
const MAX_TAGS = 3;

/** 长文本阈值（字符数）。 */
const LONG_TEXT_MIN = 500;

/** 标签名长度上限。 */
const MAX_TAG_LENGTH = 24;

/**
 * 标签权重：
 * - primary：结构化标签（类别、格式、联系方式）。命中就说明"这是什么"，优先展示。
 * - neutral：长度类标签，与结构化标签可共存（长文本 + 代码 是有意义的组合）。
 * - weak：语言占比类弱标签。★ 只在没有任何 primary 命中时出现 ——
 *   否则 "dev@example.com" 会同时被打上「邮箱」和「英文」，噪音大于信息。
 */
type TagWeight = 'primary' | 'neutral' | 'weak';

/** 归一化后的判定上下文：所有规则只看这一个对象，避免每条规则重复 trim / 分类。 */
interface OrganizeContext {
  /** 原始正文（可能含首尾空白）。 */
  text: string;
  /** trim 后的正文。 */
  trimmed: string;
  /** 小写化的 kind；非法输入为 ''。 */
  kind: string;
  /** 小写化的来源 exe；未知为 ''。 */
  sourceApp: string;
  /** 创建时间；非法输入归 0（本文件不按时间打标签，只是不让脏数据把调用方炸掉）。 */
  createdAt: number;
  /** classify() 的结果；空文本为 'text'。 */
  cls: string;
}

/**
 * 把外部输入归一成上下文。
 * ★ 全部字段都做 typeof 检查：调用方可能塞进 undefined / 数字 / 未知 kind，
 *   规则层不能因此抛异常（剪贴板数据来自系统，脏得很）。
 */
function toContext(input: OrganizeInput): OrganizeContext {
  const raw = (input ?? {}) as Partial<OrganizeInput>;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const trimmed = text.trim();
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  const sourceApp = typeof raw.sourceApp === 'string' ? raw.sourceApp.trim().toLowerCase() : '';
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  let cls = 'text';
  if (trimmed !== '') {
    try {
      cls = classify(trimmed);
    } catch {
      cls = 'text';
    }
  }
  return { text, trimmed, kind, sourceApp, createdAt, cls };
}

/** 邮箱：一个本地部分 + @ + 带点的域名（域后缀至少 2 个字母）。 */
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/;

/** 颜色：#rgb / #rrggbb / 0xrrggbb。 */
const COLOR_RE = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|0x[0-9a-fA-F]{6})$/;

/** 中文字符。 */
const CJK_RE = /[\u4e00-\u9fa5]/g;

/** 拉丁字母。 */
const LATIN_RE = /[A-Za-z]/g;

function isEmail(t: string): boolean {
  return EMAIL_RE.test(t);
}

/** 电话：去掉空格与连字符后是 11 位以 1 开头的手机号，或带 +86 前缀。 */
function isPhone(t: string): boolean {
  const compact = t.replace(/[\s-]/g, '');
  return /^(?:\+?86)?1[3-9]\d{9}$/.test(compact);
}

/** JSON：trim 后以 { 或 [ 开头，且 JSON.parse 成功（对象/数组都算）。 */
function isJson(t: string): boolean {
  if (t.length < 2) return false;
  const head = t[0];
  if (head !== '{' && head !== '[') return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function isColor(t: string): boolean {
  return COLOR_RE.test(t);
}

function nonSpaceLength(t: string): number {
  let n = 0;
  for (const ch of t) {
    if (!/\s/.test(ch)) n++;
  }
  return n;
}

/** 中文：中文字符 ≥ 2 且占非空白字符的 30% 以上。 */
function isChinese(t: string): boolean {
  const cjk = (t.match(CJK_RE) ?? []).length;
  if (cjk < 2) return false;
  const total = nonSpaceLength(t);
  return total > 0 && cjk / total >= 0.3;
}

/** 英文：拉丁字母 ≥ 4 且占非空白字符的 60% 以上。 */
function isEnglish(t: string): boolean {
  const latin = (t.match(LATIN_RE) ?? []).length;
  if (latin < 4) return false;
  const total = nonSpaceLength(t);
  return total > 0 && latin / total >= 0.6;
}

/** 长文本：trim 后字符数 ≥ 500。 */
function isLongText(t: string): boolean {
  return [...t].length >= LONG_TEXT_MIN;
}

interface TagRule {
  tag: string;
  weight: TagWeight;
  /** 判定条件，只读上下文。 */
  test: (ctx: OrganizeContext) => boolean;
}

/**
 * 标签规则表（★ 表驱动：顺序即 AUTO_TAGS 顺序即界面展示顺序）。
 * 加规则只改这张表；AUTO_TAGS 由它派生，避免"加了规则忘了补词表"。
 */
const TAG_RULES: readonly TagRule[] = [
  { tag: '链接', weight: 'primary', test: (c) => c.kind === 'link' || c.cls === 'link' },
  { tag: '代码', weight: 'primary', test: (c) => c.kind === 'code' || c.cls === 'code' },
  { tag: '路径', weight: 'primary', test: (c) => c.kind === 'path' || c.cls === 'path' },
  { tag: '数字', weight: 'primary', test: (c) => c.kind === 'number' || c.cls === 'number' },
  { tag: '图片', weight: 'primary', test: (c) => c.kind === 'image' },
  { tag: '文件', weight: 'primary', test: (c) => c.kind === 'files' },
  { tag: '邮箱', weight: 'primary', test: (c) => isEmail(c.trimmed) },
  { tag: '电话', weight: 'primary', test: (c) => isPhone(c.trimmed) },
  { tag: 'JSON', weight: 'primary', test: (c) => isJson(c.trimmed) },
  { tag: '颜色', weight: 'primary', test: (c) => isColor(c.trimmed) },
  { tag: '中文', weight: 'weak', test: (c) => isChinese(c.trimmed) },
  { tag: '英文', weight: 'weak', test: (c) => isEnglish(c.trimmed) },
  { tag: '长文本', weight: 'neutral', test: (c) => isLongText(c.trimmed) },
];

/** 固定标签词表（顺序即界面展示顺序）。新增标签必须同时补进这里。 */
export const AUTO_TAGS: readonly string[] = TAG_RULES.map((r) => r.tag);

/** 本地规则建议的标签（可能为空数组；去重、顺序稳定）。 */
export function suggestTags(input: OrganizeInput): string[] {
  const ctx = toContext(input);
  const matched = TAG_RULES.filter((rule) => {
    try {
      return rule.test(ctx);
    } catch {
      return false;
    }
  });
  const hasPrimary = matched.some((r) => r.weight === 'primary');
  return matched
    .filter((r) => !(r.weight === 'weak' && hasPrimary))
    .map((r) => r.tag)
    .slice(0, MAX_TAGS);
}

/** 被认作"开发工具"的来源 exe（小写）。这些来源的文本优先归到「代码」。 */
const DEV_SOURCE_APPS: readonly string[] = [
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'devenv.exe',
  'idea64.exe',
  'webstorm64.exe',
  'pycharm64.exe',
  'goland64.exe',
  'rider64.exe',
  'sublime_text.exe',
  'notepad++.exe',
  'vim.exe',
  'nvim.exe',
  'windowsterminal.exe',
];

interface FolderRule {
  /** 建议的一级文件夹名。 */
  folder: string;
  test: (ctx: OrganizeContext, tags: readonly string[]) => boolean;
}

/**
 * 一级文件夹建议规则表（★ 表驱动，顺序即优先级，第一条命中即返回）。
 * 优先级取舍：类别（图片/文件/链接/代码）比"来源应用"更贴近用户的心智模型 ——
 * 从 VS Code 里复制的网址归「链接」比归「代码」更有用，所以来源规则排在类别之后。
 */
const FOLDER_RULES: readonly FolderRule[] = [
  { folder: '图片', test: (c) => c.kind === 'image' },
  { folder: '文件', test: (c) => c.kind === 'files' },
  { folder: '链接', test: (c) => c.kind === 'link' || c.cls === 'link' },
  { folder: '代码', test: (c) => c.kind === 'code' || c.cls === 'code' },
  { folder: '代码', test: (c) => DEV_SOURCE_APPS.includes(c.sourceApp) },
  { folder: '联系信息', test: (_c, tags) => tags.includes('邮箱') || tags.includes('电话') },
];

/** 本地规则建议的一级文件夹名（如 '链接' / '代码' / '图片'）；不建议时为 undefined。 */
export function suggestFolder(input: OrganizeInput): string | undefined {
  const ctx = toContext(input);
  const tags = suggestTags(input);
  for (const rule of FOLDER_RULES) {
    try {
      if (rule.test(ctx, tags)) return rule.folder;
    } catch {
      // 规则自身出错就跳过，绝不让建议逻辑抛给调用方
    }
  }
  return undefined;
}

/** 标签名归一：去首尾空白、去 #、压缩内部空白、长度上限 24、空串返回 ''。 */
export function sanitizeTag(raw: string): string {
  if (typeof raw !== 'string') return '';
  const withoutHash = raw.replace(/#/g, '');
  const collapsed = withoutHash.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '';
  // ★ 用码点切而不是 slice：emoji 标签被砍成半个代理对会渲染成乱码。
  return [...collapsed].slice(0, MAX_TAG_LENGTH).join('');
}

/** 多级文件夹节点（与后续 folders 表字段一一对应）。 */
export interface OrganizeFolder {
  id: string;
  name: string;
  /** 顶级文件夹为 null。 */
  parentId: string | null;
}

/** 文件夹嵌套深度上限（含根）。 */
export const MAX_FOLDER_DEPTH = 3;

/** 把外部传入的文件夹数组洗成干净结构：丢非法项、同 id 保留第一条。 */
function normalizeFolders(folders: OrganizeFolder[]): OrganizeFolder[] {
  const out: OrganizeFolder[] = [];
  if (!Array.isArray(folders)) return out;
  const seen = new Set<string>();
  for (const f of folders) {
    if (!f || typeof f !== 'object') continue;
    if (typeof f.id !== 'string' || f.id === '') continue;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({
      id: f.id,
      name: typeof f.name === 'string' ? f.name : '',
      parentId: typeof f.parentId === 'string' && f.parentId !== '' ? f.parentId : null,
    });
  }
  return out;
}

function indexById(folders: OrganizeFolder[]): Map<string, OrganizeFolder> {
  const byId = new Map<string, OrganizeFolder>();
  for (const f of folders) byId.set(f.id, f);
  return byId;
}

/** 1-based 深度；id 不存在或祖先链有环时返回 0（0 表示"不可用"）。 */
function depthOf(byId: Map<string, OrganizeFolder>, id: string): number {
  const seen = new Set<string>();
  let cur: string | null = id;
  let depth = 0;
  while (cur !== null) {
    if (seen.has(cur)) return 0;
    const node = byId.get(cur);
    if (!node) return 0;
    seen.add(cur);
    depth++;
    cur = node.parentId;
  }
  return depth;
}

/** 以 id 为根的子树高度（自身为 1）。用 BFS 逐层数，seen 保证环不会死循环。 */
function subtreeHeight(byId: Map<string, OrganizeFolder>, rootId: string): number {
  const seen = new Set<string>([rootId]);
  let frontier: string[] = [rootId];
  let height = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const f of byId.values()) {
        if (f.parentId === id && !seen.has(f.id)) {
          seen.add(f.id);
          next.push(f.id);
        }
      }
    }
    if (next.length === 0) break;
    height++;
    frontier = next;
  }
  return height;
}

/**
 * 从 id 回溯到根的路径（含自身）；id 不存在返回 []；数据里有环时安全终止（不死循环）。
 * ★ 返回顺序是根 → 自身（面包屑天然按这个方向渲染）；环被截断在重复节点处。
 */
export function folderPathOf(
  folders: OrganizeFolder[],
  id: string | null | undefined,
): OrganizeFolder[] {
  if (typeof id !== 'string' || id === '') return [];
  const byId = indexById(normalizeFolders(folders));
  const path: OrganizeFolder[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur !== null) {
    if (seen.has(cur)) break;
    const node = byId.get(cur);
    if (!node) break;
    seen.add(cur);
    path.push(node);
    cur = node.parentId;
  }
  return path.reverse();
}

/**
 * 移动是否合法：不能移到自身/自己的后代（防环）、深度不能超过 MAX_FOLDER_DEPTH、目标必须存在。
 * ★ 防环是硬要求：一旦允许移到自己的后代，树就从"森林"退化成环，
 *   buildFolderTree / folderPathOf 只能靠 visited 兜底，界面会整块消失。
 * ★ 深度校验看的是整棵子树的高度，不只是被移动节点自身 —— 否则移一次就让子孙越界。
 */
export function canMoveFolder(
  folders: OrganizeFolder[],
  id: string,
  newParentId: string | null,
): boolean {
  const byId = indexById(normalizeFolders(folders));
  if (typeof id !== 'string' || !byId.has(id)) return false;

  const height = subtreeHeight(byId, id);

  if (newParentId === null) return height <= MAX_FOLDER_DEPTH;
  if (typeof newParentId !== 'string' || !byId.has(newParentId)) return false;
  if (newParentId === id) return false;

  // 目标不能是自己的后代：从目标往上爬，撞到 id 就拒绝
  const seen = new Set<string>();
  let cur: string | null = newParentId;
  while (cur !== null) {
    if (seen.has(cur)) return false; // 现有数据已有环，先当非法处理
    if (cur === id) return false;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }

  const parentDepth = depthOf(byId, newParentId);
  if (parentDepth === 0) return false;
  return parentDepth + height <= MAX_FOLDER_DEPTH;
}

/** 供界面渲染的树节点。 */
export interface FolderTreeNode extends OrganizeFolder {
  depth: number;
  children: FolderTreeNode[];
}

function compareName(a: OrganizeFolder, b: OrganizeFolder): number {
  return a.name.localeCompare(b.name, 'zh');
}

/**
 * 按多级路径把扁平列表拼成树，供界面渲染；同层按名字排序（localeCompare 'zh'）。
 *
 * ★ 孤立节点（parentId 指向不存在的 id）**提升为根节点**，并原样保留 parentId：
 *   数据被删一半时宁可让它出现在顶层（用户看得见、能修），也不要整块消失。
 * ★ 自环（parentId === id）同样按根处理；跨节点成环的那批节点永远到不了根，
 *   构建完再从剩余节点里补一遍当根渲染 —— 数据坏了也不能让界面丢内容。
 */
export function buildFolderTree(folders: OrganizeFolder[]): FolderTreeNode[] {
  const list = normalizeFolders(folders);
  const byId = indexById(list);
  const childrenOf = new Map<string, OrganizeFolder[]>();
  const roots: OrganizeFolder[] = [];

  for (const f of byId.values()) {
    const pid = f.parentId;
    if (pid === null || pid === f.id || !byId.has(pid)) {
      roots.push(f);
      continue;
    }
    const bucket = childrenOf.get(pid);
    if (bucket) bucket.push(f);
    else childrenOf.set(pid, [f]);
  }

  const visited = new Set<string>();
  const build = (folder: OrganizeFolder, depth: number): FolderTreeNode => {
    visited.add(folder.id);
    const kids = (childrenOf.get(folder.id) ?? [])
      .filter((k) => !visited.has(k.id))
      .sort(compareName);
    const node: FolderTreeNode = {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      depth,
      children: [],
    };
    node.children = kids.map((k) => build(k, depth + 1));
    return node;
  };

  const result = roots.sort(compareName).map((r) => build(r, 0));

  // 环内的节点到不了任何根，补一轮当根渲染
  for (const f of byId.values()) {
    if (!visited.has(f.id)) result.push(build(f, 0));
  }

  return result.sort(compareName);
}
