/**
 * 整理视图的纯逻辑（v1.0.0 ⑥）。
 *
 * 全部是纯函数：不 import react、不碰 store、不碰 IO。
 * 仓库的 vitest 只有 node 环境（没有 jsdom），所以能测的东西一律放在这里，
 * OrganizeViewCard.tsx / OrganizeItemDialog.tsx 只负责把结果摆到 DOM 上。
 *
 * 树运算（防环、孤儿提升、路径）**不在这里重写**：organize.ts 已经有
 * folderPathOf / canMoveFolder / buildFolderTree，重复一份迟早会两边不一致。
 * 这里只补「渲染成行」和「筛选条文案」这两件界面专属的事。
 */

import type { ClipItemDTO, FolderDTO, TagCountDTO } from '../types';
import { canMoveFolder, folderPathOf } from '../logic/organize';

/** 树展开成渲染行（深度优先）。 */
export interface FolderRow {
  id: string;
  name: string;
  /** 根为 0。 */
  depth: number;
  /** 自身直接挂的记录条数（不含子文件夹）。 */
  itemCount: number;
  /** 自身 + 所有子孙的条数：行上只显示这一个数，用户靠它判断这一支有多少东西。 */
  totalCount: number;
  hasChildren: boolean;
}

/** 面包屑文案里没有任何文件夹时的兜底。 */
const UNFILED_LABEL = '未归类';

/** 路径连接符。 */
const PATH_SEPARATOR = ' / ';

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'zh');
}

/**
 * 洗数据：丢非法项、同 id 只留第一条、parentId 空串归一成 null。
 * ★ organize.ts 里的 normalizeFolders 没导出，这里必须自带一份：重复 id 会让
 *   下面的 visited 记账错位（同一行出现两次、totalCount 被算两遍）。
 */
function cleanFolders(folders: FolderDTO[]): FolderDTO[] {
  const out: FolderDTO[] = [];
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
      itemCount: typeof f.itemCount === 'number' && Number.isFinite(f.itemCount) ? f.itemCount : 0,
    });
  }
  return out;
}

/**
 * 树展开成渲染行：深度优先，depth 从 0 起，同层按名称 localeCompare('zh') 排序。
 *
 * ★ 孤儿（parentId 指向不存在的 id）与自环**当根渲染**：数据被删掉一半时宁可让它
 *   出现在顶层（用户看得见、能修），也不要整块消失。
 * ★ 跨节点成环的那批节点永远到不了根，最后补一轮当根渲染；visited 保证每个 id
 *   只出现一次、且遍历一定终止 —— 脏数据不能让界面死循环。
 * ★ 用显式栈而不是递归：脏数据里深度可能远超 MAX_FOLDER_DEPTH，递归会爆栈。
 */
export function folderRows(folders: FolderDTO[]): FolderRow[] {
  const list = cleanFolders(folders);
  const byId = new Map<string, FolderDTO>();
  for (const f of list) byId.set(f.id, f);

  const childrenOf = new Map<string, FolderDTO[]>();
  const roots: FolderDTO[] = [];
  for (const f of list) {
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
  const rows: FolderRow[] = [];

  const walk = (root: FolderDTO): void => {
    const stack: { node: FolderDTO; depth: number }[] = [{ node: root, depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const node = frame.node;
      const depth = frame.depth;
      if (visited.has(node.id)) continue;
      visited.add(node.id);

      const kids = (childrenOf.get(node.id) ?? [])
        .filter((k) => !visited.has(k.id))
        .sort(compareByName);
      rows.push({
        id: node.id,
        name: node.name,
        depth,
        itemCount: node.itemCount,
        // totalCount 先放自身条数，末尾统一自底向上累加子孙。
        totalCount: node.itemCount,
        hasChildren: kids.length > 0,
      });

      // 逆序入栈：栈是后进先出，这样弹出顺序才与 kids 的排序一致。
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        const kid = kids[i];
        if (kid) stack.push({ node: kid, depth: depth + 1 });
      }
    }
  };

  for (const r of roots.slice().sort(compareByName)) walk(r);
  // 环内的节点到不了任何根，补一轮当根渲染（visited 保证不会重复）。
  for (const f of list) {
    if (!visited.has(f.id)) walk(f);
  }

  // totalCount 汇总：行是深度优先序，倒着扫一遍即可保证先累加完子孙再累加自己。
  const totalById = new Map<string, number>();
  for (const row of rows) totalById.set(row.id, row.itemCount);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    const parentId = byId.get(row.id)?.parentId ?? null;
    // 自环与孤儿没有真正挂到某个父行上，别把条数加到不存在的边里。
    if (parentId === null || parentId === row.id) continue;
    if (!totalById.has(parentId)) continue;
    totalById.set(parentId, (totalById.get(parentId) ?? 0) + (totalById.get(row.id) ?? 0));
  }
  for (const row of rows) row.totalCount = totalById.get(row.id) ?? row.itemCount;

  return rows;
}

/** 面包屑文案：根到自身用 ' / ' 连接；id 为 null/undefined/不存在 → '未归类'。 */
export function folderPathLabel(folders: FolderDTO[], id: string | null | undefined): string {
  const path = folderPathOf(folders, id);
  if (path.length === 0) return UNFILED_LABEL;
  return path.map((f) => f.name).join(PATH_SEPARATOR);
}

/** 移动目标候选。 */
export interface FolderTarget {
  id: string;
  label: string;
}

/**
 * 移动目标候选：排除自己与自己的所有子孙（含超深），并按 folderPathLabel 给出路径文案。
 *
 * ★ 逐个交给 canMoveFolder 校验，而不是在渲染层再写一套「排除子孙 + 深度」的判断：
 *   深度上限（MAX_FOLDER_DEPTH）与子树高度的耦合只有 organize.ts 知道，复制一遍
 *   迟早出现「列表里能选、点下去被主进程拒绝」的错位。
 * ★ movingId 为 null（新建 / 没选中）时返回全部文件夹。
 */
export function folderMoveTargets(folders: FolderDTO[], movingId: string | null): FolderTarget[] {
  const list = cleanFolders(folders);
  const targets: FolderTarget[] = [];
  for (const f of list) {
    if (movingId !== null && !canMoveFolder(list, movingId, f.id)) continue;
    targets.push({ id: f.id, label: folderPathLabel(list, f.id) });
  }
  // 按完整路径排序：父在前、同层按名字，跟左栏树的阅读顺序一致。
  return targets.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

/** 列表顶部当前筛选的说明片段。 */
export interface FilterChip {
  kind: 'tag' | 'folder';
  label: string;
  /** 标签：标签名；文件夹：文件夹 id（未归类为 ''）。清筛选时原样交回给动作。 */
  value: string;
}

/** 列表顶部当前筛选的说明片段；无筛选返回 []。 */
export function filterChips(
  tagFilter: string[],
  folderFilter: string | null | undefined,
  folders: FolderDTO[],
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (Array.isArray(tagFilter)) {
    for (const tag of tagFilter) {
      if (typeof tag === 'string' && tag !== '') chips.push({ kind: 'tag', label: tag, value: tag });
    }
  }
  // ★ 三态必须分开写：undefined 是「不限」（不产生片段），null 是「只看未归类」（要产生一片）。
  if (folderFilter === null) {
    chips.push({ kind: 'folder', label: UNFILED_LABEL, value: '' });
  } else if (typeof folderFilter === 'string') {
    chips.push({ kind: 'folder', label: folderPathLabel(folders, folderFilter), value: folderFilter });
  }
  return chips;
}

/**
 * 记录当前标签 → 可切换的候选：knownTags 全量 + 记录自身标签，去重，按出现次数降序。
 *
 * ★ 自身标签一定要并进来：knownTags 是「全库统计」，一条记录刚打上、还没进统计的
 *   新标签不在里面，不并的话 chip 会当场消失，用户以为没打上。
 * ★ 同频次按名字 localeCompare('zh') 兜底，否则每次渲染顺序都可能变，看着像在跳。
 * ★ 自身标签的次数按 0 算：它只影响相对位置，不会把常用标签挤下去。
 */
export function tagCandidates(knownTags: TagCountDTO[], itemTags: string[]): string[] {
  const counts = new Map<string, number>();
  if (Array.isArray(knownTags)) {
    for (const entry of knownTags) {
      if (!entry || typeof entry.tag !== 'string' || entry.tag === '') continue;
      const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0;
      counts.set(entry.tag, Math.max(counts.get(entry.tag) ?? 0, count));
    }
  }
  if (Array.isArray(itemTags)) {
    for (const tag of itemTags) {
      if (typeof tag !== 'string' || tag === '') continue;
      if (!counts.has(tag)) counts.set(tag, 0);
    }
  }
  return [...counts.keys()].sort((a, b) => {
    const delta = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return delta !== 0 ? delta : a.localeCompare(b, 'zh');
  });
}

/** 整理视图的空态：没有文件夹、也没有标签时给一句引导（否则整页两个空白栏）。 */
export function isOrganizeEmpty(folders: FolderDTO[], knownTags: TagCountDTO[]): boolean {
  const folderCount = Array.isArray(folders) ? folders.length : 0;
  const tagCount = Array.isArray(knownTags) ? knownTags.length : 0;
  return folderCount === 0 && tagCount === 0;
}

/** 条数文案：0 也照写（不省略），否则空文件夹看起来像数据没加载出来。 */
export function countLabel(count: number): string {
  const n = typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return n + ' 条';
}

/** 标签集合切换：已有则移除，没有则追加（保持既有顺序，新标签排最后）。 */
export function toggleTag(tags: string[], tag: string): string[] {
  const list = Array.isArray(tags) ? tags : [];
  if (typeof tag !== 'string' || tag === '') return [...list];
  return list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag];
}

/** 记录的标签列表（ClipItemDTO.tags 可能 undefined，统一成新数组，别改到 store 里的原数组）。 */
export function itemTagsOf(item: ClipItemDTO | undefined): string[] {
  const tags = item?.tags;
  return Array.isArray(tags) ? [...tags] : [];
}
