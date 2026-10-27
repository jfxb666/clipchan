/**
 * 整理视图纯逻辑单测（v1.0.0 ⑥）。
 *
 * 仓库的 vitest 只跑 node 环境、没有 jsdom（见 keymap.spec.ts 的文件头），
 * OrganizeViewCard.tsx / OrganizeItemDialog.tsx 渲染不了；这里断言的是从组件里
 * 抽出来的判定函数，组件只负责把结果摆到 DOM 上。
 */
import { describe, expect, it } from 'vitest';
import type { ClipItemDTO, FolderDTO, TagCountDTO } from '../types';
import {
  countLabel,
  filterChips,
  folderMoveTargets,
  folderPathLabel,
  folderRows,
  isOrganizeEmpty,
  itemTagsOf,
  tagCandidates,
  toggleTag,
} from './organizeView';

function folder(id: string, name: string, parentId: string | null, itemCount = 0): FolderDTO {
  return { id, name, parentId, itemCount };
}

function idsOf(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id);
}

describe('folderRows', () => {
  it('深度优先展开：父在前、子紧随其后，depth 从 0 起逐层加一', () => {
    const rows = folderRows([
      folder('a', '甲', null),
      folder('a1', '甲一', 'a'),
      folder('a1x', '甲一一', 'a1'),
      folder('b', '乙', null),
    ]);
    expect(idsOf(rows)).toEqual(['a', 'a1', 'a1x', 'b']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 0]);
  });

  it('同层按名称排序（localeCompare zh 即拼音序），不是插入序', () => {
    const rows = folderRows([
      folder('x', '西瓜', null),
      folder('y', '苹果', null),
      folder('z', '香蕉', null),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['苹果', '西瓜', '香蕉']);
  });

  it('子节点同样按名称排序（拼音序：er 在 yi 之前，故「二」排「一」前）', () => {
    const rows = folderRows([
      folder('p', '父', null),
      folder('p1', '一', 'p'),
      folder('p2', '二', 'p'),
    ]);
    expect(idsOf(rows)).toEqual(['p', 'p2', 'p1']);
  });

  it('totalCount = 自身 itemCount + 所有子孙 itemCount', () => {
    const rows = folderRows([
      folder('a', '甲', null, 1),
      folder('a1', '甲一', 'a', 2),
      folder('a1x', '甲一一', 'a1', 4),
      folder('a2', '甲二', 'a', 8),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('a1x')?.totalCount).toBe(4);
    expect(byId.get('a1')?.totalCount).toBe(6);
    expect(byId.get('a2')?.totalCount).toBe(8);
    // 1 + (2 + 4) + 8
    expect(byId.get('a')?.totalCount).toBe(15);
  });

  it('itemCount 只算自己，不吞子孙', () => {
    const rows = folderRows([folder('a', '甲', null, 3), folder('a1', '甲一', 'a', 5)]);
    expect(rows.find((r) => r.id === 'a')?.itemCount).toBe(3);
  });

  it('hasChildren 只反映有没有子节点', () => {
    const rows = folderRows([
      folder('a', '甲', null),
      folder('a1', '甲一', 'a'),
      folder('b', '乙', null),
    ]);
    expect(rows.find((r) => r.id === 'a')?.hasChildren).toBe(true);
    expect(rows.find((r) => r.id === 'a1')?.hasChildren).toBe(false);
    expect(rows.find((r) => r.id === 'b')?.hasChildren).toBe(false);
  });

  it('孤儿（parentId 指向不存在的 id）提升为根，depth 归 0 而不是整块消失', () => {
    const rows = folderRows([folder('a', '甲', 'ghost'), folder('b', '乙', null)]);
    expect(idsOf(rows).sort()).toEqual(['a', 'b']);
    expect(rows.find((r) => r.id === 'a')?.depth).toBe(0);
  });

  it('自环（parentId === 自身 id）当根渲染，只出现一次', () => {
    const rows = folderRows([folder('a', '甲', 'a')]);
    expect(idsOf(rows)).toEqual(['a']);
    expect(rows[0]?.depth).toBe(0);
  });

  it('跨节点成环时不死循环、每个节点只出现一次', () => {
    // A→B→C→A：没有任何节点能到根，全部靠"补一轮当根"兜底。
    const rows = folderRows([
      folder('a', '甲', 'c'),
      folder('b', '乙', 'a'),
      folder('c', '丙', 'b'),
    ]);
    expect(rows).toHaveLength(3);
    expect(idsOf(rows).sort()).toEqual(['a', 'b', 'c']);
    expect(new Set(idsOf(rows)).size).toBe(3);
  });

  it('环里能到根的那部分仍然按正常层级展开', () => {
    // 根 r → a ⇄ b（a、b 互指成环）
    const rows = folderRows([
      folder('r', '根', null),
      folder('a', '甲', 'r'),
      folder('b', '乙', 'a'),
    ]);
    expect(idsOf(rows)).toEqual(['r', 'a', 'b']);
    expect(rows.map((x) => x.depth)).toEqual([0, 1, 2]);
  });

  it('空数组返回空数组', () => {
    expect(folderRows([])).toEqual([]);
  });

  it('重复 id 只保留第一条，避免同一行渲染两次、条数算两遍', () => {
    const rows = folderRows([
      folder('a', '甲', null, 1),
      folder('a', '甲改名', null, 9),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('甲');
    expect(rows[0]?.itemCount).toBe(1);
  });

  it('itemCount 缺失或非法时按 0 算，不产生 NaN', () => {
    const dirty = [
      { id: 'a', name: '甲', parentId: null },
      { id: 'b', name: '乙', parentId: null, itemCount: Number.NaN },
    ] as unknown as FolderDTO[];
    const rows = folderRows(dirty);
    expect(rows.map((r) => r.totalCount)).toEqual([0, 0]);
  });

  it('同一份数据反复调用结果稳定（纯函数，不改入参）', () => {
    const input = [folder('a', '甲', null, 2), folder('a1', '甲一', 'a', 3)];
    const snapshot = JSON.stringify(input);
    expect(folderRows(input)).toEqual(folderRows(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('folderPathLabel', () => {
  const folders = [
    folder('a', '工作', null),
    folder('b', '文档', 'a'),
    folder('c', '周报', 'b'),
  ];

  it('根到自身用 " / " 连接', () => {
    expect(folderPathLabel(folders, 'c')).toBe('工作 / 文档 / 周报');
  });

  it('一级文件夹就是自己的名字（没有前导分隔符）', () => {
    expect(folderPathLabel(folders, 'a')).toBe('工作');
  });

  it('id 为 null / undefined / 不存在时都是「未归类」', () => {
    expect(folderPathLabel(folders, null)).toBe('未归类');
    expect(folderPathLabel(folders, undefined)).toBe('未归类');
    expect(folderPathLabel(folders, 'ghost')).toBe('未归类');
  });

  it('数据成环时安全终止，不会无限拼接', () => {
    const cyclic = [folder('a', '甲', 'b'), folder('b', '乙', 'a')];
    expect(folderPathLabel(cyclic, 'a')).toBe('乙 / 甲');
  });
});

describe('folderMoveTargets', () => {
  it('movingId 为 null 时返回全部文件夹，label 是完整路径', () => {
    const folders = [folder('a', '工作', null), folder('b', '文档', 'a')];
    const targets = folderMoveTargets(folders, null);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect(targets.find((t) => t.id === 'b')?.label).toBe('工作 / 文档');
  });

  it('排除自己', () => {
    const folders = [folder('a', '甲', null), folder('b', '乙', null)];
    expect(folderMoveTargets(folders, 'a').map((t) => t.id)).toEqual(['b']);
  });

  it('排除自己的所有子孙（含隔代）', () => {
    // a 的子树高度 2（a → b），移到 z（深度 1）后 1 + 2 = 3 正好到上限，所以 z 合法 ——
    // 这条只考察"子孙被排除"，深度那部分由下一条单独考察。
    const folders = [
      folder('a', '甲', null),
      folder('b', '甲一', 'a'),
      folder('z', '乙', null),
    ];
    expect(folderMoveTargets(folders, 'a').map((t) => t.id)).toEqual(['z']);
  });

  it('排除隔代子孙（a → b → c 时 b、c 都不可选）', () => {
    const folders = [
      folder('a', '甲', null),
      folder('b', '甲一', 'a'),
      folder('c', '甲一一', 'b'),
      folder('z', '乙', null),
    ];
    // a 的子树高度 3，任何非子孙目标都放不下，所以整张候选表只剩空。
    expect(folderMoveTargets(folders, 'a')).toEqual([]);
  });

  it('排除会让整棵子树越过深度上限的目标（不只是节点自己越界）', () => {
    // p 的子树高度是 2（p → q）；x/y/z 是深度 1/2/3 的一条链。
    const folders = [
      folder('x', '一', null),
      folder('y', '二', 'x'),
      folder('z', '三', 'y'),
      folder('p', '甲', null),
      folder('q', '甲一', 'p'),
    ];
    const targetIds = folderMoveTargets(folders, 'p').map((t) => t.id);
    expect(targetIds).toContain('x'); // 1 + 2 = 3，正好到上限
    expect(targetIds).not.toContain('y'); // 2 + 2 = 4，越界
    expect(targetIds).not.toContain('z'); // 3 + 2 = 5，越界
    expect(targetIds).not.toContain('p');
    expect(targetIds).not.toContain('q');
  });

  it('movingId 本身不存在时返回空（没有合法的起点）', () => {
    const folders = [folder('a', '甲', null)];
    expect(folderMoveTargets(folders, 'ghost')).toEqual([]);
  });

  it('结果按完整路径排序，父在前', () => {
    const folders = [folder('a', '工作', null), folder('b', '文档', 'a')];
    expect(folderMoveTargets(folders, null).map((t) => t.label)).toEqual(['工作', '工作 / 文档']);
  });

  it('空文件夹列表返回空', () => {
    expect(folderMoveTargets([], 'a')).toEqual([]);
  });
});

describe('filterChips', () => {
  const folders = [folder('a', '工作', null), folder('b', '文档', 'a')];

  it('每个 tagFilter 一项，label 就是标签名', () => {
    expect(filterChips(['代码', '链接'], undefined, folders)).toEqual([
      { kind: 'tag', label: '代码', value: '代码' },
      { kind: 'tag', label: '链接', value: '链接' },
    ]);
  });

  it('folderFilter 为 string 时一项，label 用完整路径', () => {
    expect(filterChips([], 'b', folders)).toEqual([
      { kind: 'folder', label: '工作 / 文档', value: 'b' },
    ]);
  });

  it('folderFilter 为 null 时是「未归类」一项，value 为空串', () => {
    expect(filterChips([], null, folders)).toEqual([
      { kind: 'folder', label: '未归类', value: '' },
    ]);
  });

  it('folderFilter 为 undefined 时不产生文件夹项（不限 ≠ 未归类）', () => {
    expect(filterChips([], undefined, folders)).toEqual([]);
  });

  it('标签与文件夹同时存在时标签在前', () => {
    expect(filterChips(['代码'], 'a', folders).map((c) => c.kind)).toEqual(['tag', 'folder']);
  });

  it('什么都没有时返回空数组', () => {
    expect(filterChips([], undefined, [])).toEqual([]);
  });
});

describe('tagCandidates', () => {
  const known: TagCountDTO[] = [
    { tag: '代码', count: 9 },
    { tag: '链接', count: 4 },
    { tag: '图片', count: 1 },
  ];

  it('knownTags 按出现次数降序', () => {
    expect(tagCandidates(known, [])).toEqual(['代码', '链接', '图片']);
  });

  it('把记录自身标签并进来（新标签还没进全库统计也不能丢）', () => {
    const out = tagCandidates(known, ['临时']);
    expect(out).toContain('临时');
    expect(out).toHaveLength(4);
  });

  it('去重：自身标签已在 knownTags 里时不重复出现', () => {
    expect(tagCandidates(known, ['代码'])).toEqual(['代码', '链接', '图片']);
  });

  it('同频次按名称排序，顺序稳定', () => {
    const tied: TagCountDTO[] = [
      { tag: '乙', count: 2 },
      { tag: '甲', count: 2 },
    ];
    expect(tagCandidates(tied, [])).toEqual(['甲', '乙']);
  });

  it('自身标签次数按 0 算，排在常用标签之后', () => {
    expect(tagCandidates(known, ['临时'])[3]).toBe('临时');
  });

  it('空输入返回空数组', () => {
    expect(tagCandidates([], [])).toEqual([]);
  });

  it('脏数据（空标签名、非法 count）不会进结果', () => {
    const dirty = [
      { tag: '', count: 5 },
      { tag: '有效', count: Number.NaN },
    ] as unknown as TagCountDTO[];
    expect(tagCandidates(dirty, [''])).toEqual(['有效']);
  });
});

describe('toggleTag', () => {
  it('没有就追加到末尾', () => {
    expect(toggleTag(['甲'], '乙')).toEqual(['甲', '乙']);
  });

  it('已有就移除，保持其余顺序', () => {
    expect(toggleTag(['甲', '乙', '丙'], '乙')).toEqual(['甲', '丙']);
  });

  it('空标签名不改变集合，且返回新数组（不改入参）', () => {
    const input = ['甲'];
    expect(toggleTag(input, '')).toEqual(['甲']);
    expect(toggleTag(input, '甲')).not.toBe(input);
  });
});

describe('itemTagsOf', () => {
  it('tags 缺失时返回空数组', () => {
    expect(itemTagsOf(undefined)).toEqual([]);
    expect(itemTagsOf({ id: 'x' } as ClipItemDTO)).toEqual([]);
  });

  it('返回副本，改它不会改到 store 里那条记录', () => {
    const item = { id: 'x', tags: ['甲'] } as ClipItemDTO;
    const tags = itemTagsOf(item);
    tags.push('乙');
    expect(item.tags).toEqual(['甲']);
  });
});

describe('isOrganizeEmpty', () => {
  it('文件夹与标签都为空才算空态', () => {
    expect(isOrganizeEmpty([], [])).toBe(true);
    expect(isOrganizeEmpty([folder('a', '甲', null)], [])).toBe(false);
    expect(isOrganizeEmpty([], [{ tag: '代码', count: 1 }])).toBe(false);
  });
});

describe('countLabel', () => {
  it('0 也照写「0 条」，不省略', () => {
    expect(countLabel(0)).toBe('0 条');
  });

  it('正常条数直出', () => {
    expect(countLabel(12)).toBe('12 条');
  });

  it('负数与非法值按 0 处理', () => {
    expect(countLabel(-3)).toBe('0 条');
    expect(countLabel(Number.NaN)).toBe('0 条');
  });
});
