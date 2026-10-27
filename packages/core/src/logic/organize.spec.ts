import { describe, expect, it } from 'vitest';
import {
  AUTO_TAGS,
  MAX_FOLDER_DEPTH,
  buildFolderTree,
  canMoveFolder,
  folderPathOf,
  sanitizeTag,
  suggestFolder,
  suggestTags,
  type OrganizeFolder,
} from './organize';

/** 构造一个合法输入，测试里只覆盖关心的字段。 */
function input(over: Partial<{ kind: string; text: string; sourceApp: string; createdAt: number }> = {}) {
  return { kind: 'text', text: '', createdAt: 1_700_000_000_000, ...over };
}

const folders = (...items: [string, string, string | null][]): OrganizeFolder[] =>
  items.map(([id, name, parentId]) => ({ id, name, parentId }));

describe('AUTO_TAGS', () => {
  it('词表固定且顺序稳定（界面展示顺序）', () => {
    expect(AUTO_TAGS).toEqual([
      '链接', '代码', '路径', '数字', '图片', '文件',
      '邮箱', '电话', 'JSON', '颜色', '中文', '英文', '长文本',
    ]);
  });

  it('suggestTags 产出的标签一定在词表内且不重复', () => {
    const samples = [
      input({ kind: 'link', text: 'https://example.com' }),
      input({ kind: 'code', text: 'function foo() {}' }),
      input({ kind: 'image' }),
      input({ text: 'dev@example.com' }),
    ];
    for (const s of samples) {
      const tags = suggestTags(s);
      expect(new Set(tags).size).toBe(tags.length);
      for (const t of tags) expect(AUTO_TAGS).toContain(t);
    }
  });
});

describe('suggestTags 各标签正例/反例', () => {
  it('链接：正例', () => {
    expect(suggestTags(input({ kind: 'link', text: 'https://example.com/a' }))).toContain('链接');
  });

  it('链接：反例（普通英文句子）', () => {
    expect(suggestTags(input({ text: 'just some text here' }))).not.toContain('链接');
  });

  it('代码：正例（关键字命中）', () => {
    expect(suggestTags(input({ kind: 'code', text: 'const a = 1;' }))).toContain('代码');
  });

  it('代码：反例（中文短句）', () => {
    expect(suggestTags(input({ text: '今天下午三点开会' }))).not.toContain('代码');
  });

  it('路径：正例（Windows 盘符与 UNC）', () => {
    expect(suggestTags(input({ text: 'C:\\Users\\Administrator\\Desktop' }))).toContain('路径');
    expect(suggestTags(input({ text: '\\\\server\\share\\file.txt' }))).toContain('路径');
  });

  it('路径：反例', () => {
    expect(suggestTags(input({ text: 'no path here' }))).not.toContain('路径');
  });

  it('数字：正例（含千分位与百分比）', () => {
    expect(suggestTags(input({ text: '1,234.56' }))).toContain('数字');
    expect(suggestTags(input({ text: '-12.5%' }))).toContain('数字');
  });

  it('数字：反例（字母数字混合）', () => {
    expect(suggestTags(input({ text: 'abc123' }))).not.toContain('数字');
  });

  it('图片：kind=image 且正文为空串', () => {
    expect(suggestTags(input({ kind: 'image' }))).toEqual(['图片']);
  });

  it('文件：kind=files', () => {
    expect(suggestTags(input({ kind: 'files' }))).toEqual(['文件']);
  });

  it('图片/文件：普通文本反例', () => {
    const tags = suggestTags(input({ text: 'hello world' }));
    expect(tags).not.toContain('图片');
    expect(tags).not.toContain('文件');
  });

  it('邮箱：正例', () => {
    expect(suggestTags(input({ text: 'dev@example.com' }))).toEqual(['邮箱']);
    expect(suggestTags(input({ text: '联系 zhang.san@corp.com.cn 谢谢' }))).toContain('邮箱');
  });

  it('邮箱：反例（无 @ 或域名无点）', () => {
    expect(suggestTags(input({ text: 'no-at-sign here' }))).not.toContain('邮箱');
    expect(suggestTags(input({ text: 'a@b' }))).not.toContain('邮箱');
  });

  it('电话：正例（11 位 1 开头 / +86 带分隔符）', () => {
    expect(suggestTags(input({ text: '13800138000' }))).toContain('电话');
    expect(suggestTags(input({ text: '+86 138-0013-8000' }))).toContain('电话');
  });

  it('电话：反例（第二位不是 3-9）', () => {
    expect(suggestTags(input({ text: '12345678901' }))).not.toContain('电话');
  });

  it('JSON：正例（对象与数组）', () => {
    expect(suggestTags(input({ text: '{"a":1}' }))).toContain('JSON');
    expect(suggestTags(input({ text: '  [1,2,3]  ' }))).toContain('JSON');
  });

  it('JSON：反例（解析失败 / 不是 { 或 [ 开头）', () => {
    expect(suggestTags(input({ text: '{not json}' }))).not.toContain('JSON');
    expect(suggestTags(input({ text: '12345' }))).not.toContain('JSON');
  });

  it('颜色：正例（#rgb / #rrggbb / 0xrrggbb）', () => {
    expect(suggestTags(input({ text: '#aabbcc' }))).toEqual(['颜色']);
    expect(suggestTags(input({ text: '#abc' }))).toContain('颜色');
    expect(suggestTags(input({ text: '0x1a2b3c' }))).toContain('颜色');
  });

  it('颜色：反例（非十六进制 / 颜色单词）', () => {
    expect(suggestTags(input({ text: '#zzz' }))).not.toContain('颜色');
    expect(suggestTags(input({ text: 'red' }))).not.toContain('颜色');
  });

  it('中文：正例（占比 ≥ 30%）', () => {
    expect(suggestTags(input({ text: '今天下午三点开会' }))).toEqual(['中文']);
  });

  it('中文：反例（纯英文）', () => {
    expect(suggestTags(input({ text: 'hello world' }))).not.toContain('中文');
  });

  it('英文：正例（占比 ≥ 60%）', () => {
    expect(suggestTags(input({ text: 'hello world this is english text' }))).toEqual(['英文']);
  });

  it('英文：反例（拉丁字母太少）', () => {
    expect(suggestTags(input({ text: 'ab' }))).not.toContain('英文');
  });

  it('长文本：正例（≥ 500 字符）', () => {
    expect(suggestTags(input({ text: 'a'.repeat(500) }))).toContain('长文本');
  });

  it('长文本：反例（499 字符）', () => {
    expect(suggestTags(input({ text: 'a'.repeat(499) }))).not.toContain('长文本');
  });

  it('语言类弱标签在结构化标签命中时被压掉（噪音控制）', () => {
    // 邮箱是 primary，英文是 weak —— 只剩「邮箱」
    expect(suggestTags(input({ text: 'dev@example.com' }))).toEqual(['邮箱']);
  });

  it('长度类标签可与结构化标签共存', () => {
    const code = 'const a = 1;\n' + '// ' + 'x'.repeat(600);
    const tags = suggestTags(input({ kind: 'code', text: code }));
    expect(tags).toContain('代码');
    expect(tags).toContain('长文本');
  });

  it('最多返回 3 个标签，按词表顺序截断', () => {
    // 代码（classify 命中 '{\n'）+ 邮箱 + JSON + 长文本 = 4 个命中，截到 3 个
    const longJson = JSON.stringify({ mail: 'dev@example.com', note: 'x'.repeat(600) }, null, 2);
    const tags = suggestTags(input({ text: longJson }));
    expect(tags).toEqual(['代码', '邮箱', 'JSON']);
    expect(tags).toHaveLength(3);
  });

  it('空文本 / 未知 kind 返回空数组', () => {
    expect(suggestTags(input({ text: '' }))).toEqual([]);
    expect(suggestTags(input({ kind: 'unknown', text: '' }))).toEqual([]);
  });
});

describe('suggestFolder', () => {
  it('link → 链接', () => {
    expect(suggestFolder(input({ kind: 'link', text: 'https://example.com' }))).toBe('链接');
  });

  it('code → 代码', () => {
    expect(suggestFolder(input({ kind: 'code', text: 'function foo() {}' }))).toBe('代码');
  });

  it('image → 图片，files → 文件', () => {
    expect(suggestFolder(input({ kind: 'image' }))).toBe('图片');
    expect(suggestFolder(input({ kind: 'files' }))).toBe('文件');
  });

  it('带邮箱或电话的文本 → 联系信息', () => {
    expect(suggestFolder(input({ text: 'dev@example.com' }))).toBe('联系信息');
    // ★ 手机号经 classify 会变成 kind='number'，但仍应归「联系信息」，故规则看标签而非 kind
    expect(suggestFolder(input({ kind: 'number', text: '13800138000' }))).toBe('联系信息');
  });

  it('开发工具来源（Code.exe / devenv.exe）→ 代码', () => {
    expect(suggestFolder(input({ text: 'some plain note', sourceApp: 'Code.exe' }))).toBe('代码');
    expect(suggestFolder(input({ text: 'some plain note', sourceApp: 'devenv.exe' }))).toBe('代码');
  });

  it('类别优先于来源应用（VS Code 里复制的网址归链接）', () => {
    expect(
      suggestFolder(input({ kind: 'link', text: 'https://example.com', sourceApp: 'Code.exe' })),
    ).toBe('链接');
  });

  it('其余情况不建议（undefined）', () => {
    expect(suggestFolder(input({ text: '今天下午三点开会' }))).toBeUndefined();
    expect(suggestFolder(input({ kind: 'number', text: '12345' }))).toBeUndefined();
    expect(suggestFolder(input({ text: '' }))).toBeUndefined();
  });
});

describe('sanitizeTag', () => {
  it('去首尾空白与 # 前缀', () => {
    expect(sanitizeTag('  #标签  ')).toBe('标签');
    expect(sanitizeTag('##双井号')).toBe('双井号');
  });

  it('压缩内部空白', () => {
    expect(sanitizeTag('a   b\t\tc')).toBe('a b c');
  });

  it('全空白 / 只有 # 返回空串', () => {
    expect(sanitizeTag('   ')).toBe('');
    expect(sanitizeTag('###')).toBe('');
  });

  it('长度上限 24', () => {
    const out = sanitizeTag('x'.repeat(40));
    expect(out).toBe('x'.repeat(24));
    expect([...out]).toHaveLength(24);
  });

  it('按码点截断，不切坏代理对（emoji）', () => {
    const out = sanitizeTag('🙂'.repeat(30));
    expect([...out]).toHaveLength(24);
    expect(out).toBe('🙂'.repeat(24));
  });
});

describe('folderPathOf', () => {
  it('单级：只返回自身', () => {
    const list = folders(['a', 'A', null]);
    expect(folderPathOf(list, 'a').map((f) => f.id)).toEqual(['a']);
  });

  it('多级：从根到自身', () => {
    const list = folders(['a', 'A', null], ['b', 'B', 'a'], ['c', 'C', 'b']);
    expect(folderPathOf(list, 'c').map((f) => f.name)).toEqual(['A', 'B', 'C']);
  });

  it('id 不存在 / null / undefined 返回空数组', () => {
    const list = folders(['a', 'A', null]);
    expect(folderPathOf(list, 'missing')).toEqual([]);
    expect(folderPathOf(list, null)).toEqual([]);
    expect(folderPathOf(list, undefined)).toEqual([]);
    expect(folderPathOf([], 'a')).toEqual([]);
  });

  it('数据里有环时安全终止（不死循环）', () => {
    const list = folders(['a', 'A', 'b'], ['b', 'B', 'a']);
    const path = folderPathOf(list, 'a');
    expect(path).toHaveLength(2);
    expect(path.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });
});

describe('canMoveFolder', () => {
  it('合法移动：同一层内换父', () => {
    const list = folders(['r1', 'R1', null], ['r2', 'R2', null], ['x', 'X', 'r1']);
    expect(canMoveFolder(list, 'x', 'r2')).toBe(true);
  });

  it('合法移动：移到根（null）', () => {
    const list = folders(['a', 'A', null], ['b', 'B', 'a']);
    expect(canMoveFolder(list, 'b', null)).toBe(true);
  });

  it('非法：移到自身', () => {
    const list = folders(['a', 'A', null], ['b', 'B', 'a']);
    expect(canMoveFolder(list, 'a', 'a')).toBe(false);
  });

  it('非法：移到自己的后代（防环）', () => {
    const list = folders(['a', 'A', null], ['b', 'B', 'a'], ['c', 'C', 'b']);
    expect(canMoveFolder(list, 'a', 'b')).toBe(false);
    expect(canMoveFolder(list, 'a', 'c')).toBe(false);
  });

  it('非法：深度超过 MAX_FOLDER_DEPTH（看整棵子树高度）', () => {
    // P→Q→R 已有 3 层；把高度为 2 的 S（S→T）挂到深度 2 的 Q 下 → 4 层
    const list = folders(
      ['p', 'P', null], ['q', 'Q', 'p'], ['r', 'R', 'q'],
      ['s', 'S', null], ['t', 'T', 's'],
    );
    expect(MAX_FOLDER_DEPTH).toBe(3);
    expect(canMoveFolder(list, 's', 'q')).toBe(false);
    // 同一棵树移到根仍合法
    expect(canMoveFolder(list, 's', null)).toBe(true);
    // 只挂一个叶子到最深层就会越界
    expect(canMoveFolder(list, 't', 'r')).toBe(false);
  });

  it('非法：目标不存在或 id 不存在', () => {
    const list = folders(['a', 'A', null]);
    expect(canMoveFolder(list, 'a', 'ghost')).toBe(false);
    expect(canMoveFolder(list, 'ghost', null)).toBe(false);
  });

  it('非法：现有数据已有环时按不可移动处理', () => {
    const list = folders(['a', 'A', 'b'], ['b', 'B', 'a']);
    expect(canMoveFolder(list, 'a', 'b')).toBe(false);
  });
});

describe('buildFolderTree', () => {
  it('两层：挂到正确的父节点下', () => {
    const list = folders(['a', 'A', null], ['b', 'B', 'a'], ['c', 'C', 'a']);
    const tree = buildFolderTree(list);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe('a');
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children.map((n) => n.id).sort()).toEqual(['b', 'c']);
    expect(tree[0]!.children.every((n) => n.depth === 1)).toBe(true);
  });

  it('同层按名字排序（localeCompare zh，拼音序 丙 < 甲 < 乙）', () => {
    const list = folders(
      ['c', '丙', null], ['a', '甲', null], ['b', '乙', null],
    );
    expect(buildFolderTree(list).map((n) => n.name)).toEqual(['丙', '甲', '乙']);
  });

  it('孤立节点（parentId 指向不存在的 id）提升为根', () => {
    const list = folders(['a', 'A', null], ['b', 'B', 'ghost']);
    const tree = buildFolderTree(list);
    const ids = tree.map((n) => n.id).sort();
    expect(ids).toEqual(['a', 'b']);
    // ★ parentId 原样保留，界面能据此提示"父文件夹已删除"
    expect(tree.find((n) => n.id === 'b')!.parentId).toBe('ghost');
  });

  it('自环节点按根处理，跨节点成环的那批节点也不会丢', () => {
    // ★ b↔c 互相为父：两者都到不了根，构建完补一轮当根渲染，c 挂在 b 下
    const list = folders(['a', 'A', 'a'], ['b', 'B', 'c'], ['c', 'C', 'b']);
    const tree = buildFolderTree(list);
    const flat: string[] = [];
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) { flat.push(n.id); walk(n.children); }
    };
    walk(tree);
    expect(flat.sort()).toEqual(['a', 'b', 'c']);
    expect(tree.map((n) => n.id)).toContain('a');
  });

  it('空数组 / 非法输入返回空树', () => {
    expect(buildFolderTree([])).toEqual([]);
    expect(buildFolderTree(null as unknown as OrganizeFolder[])).toEqual([]);
  });
});

describe('异常输入不抛异常', () => {
  it('suggestTags / suggestFolder 对脏输入返回安全值', () => {
    const dirty = [
      {} as never,
      { kind: '???', text: undefined, createdAt: Number.NaN } as never,
      { kind: null, text: null, sourceApp: null, createdAt: 'x' } as never,
      { kind: 'image', text: 12345 } as never,
    ];
    for (const d of dirty) {
      expect(() => suggestTags(d)).not.toThrow();
      expect(() => suggestFolder(d)).not.toThrow();
      expect(Array.isArray(suggestTags(d))).toBe(true);
    }
    expect(suggestTags({ kind: '???', text: undefined, createdAt: Number.NaN } as never)).toEqual([]);
    // kind 判定不依赖 text，脏 text 也照样给图片
    expect(suggestFolder({ kind: 'image', text: 12345 } as never)).toBe('图片');
  });

  it('sanitizeTag 对非字符串返回空串', () => {
    expect(sanitizeTag(undefined as unknown as string)).toBe('');
    expect(sanitizeTag(null as unknown as string)).toBe('');
    expect(sanitizeTag(123 as unknown as string)).toBe('');
  });

  it('文件夹函数对空数组 / 缺失 id 不抛异常', () => {
    expect(() => folderPathOf([], 'a')).not.toThrow();
    expect(() => canMoveFolder([], 'a', null)).not.toThrow();
    expect(canMoveFolder([], 'a', null)).toBe(false);
  });
});
