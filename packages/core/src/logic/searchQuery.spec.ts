import { describe, expect, it } from 'vitest';
import type { SearchNode } from './searchQuery';
import { matchSearch, parseSearch } from './searchQuery';

const text = (value: string): SearchNode => ({ op: 'leaf', kind: 'text', value });
const re = (value: string, flags = ''): SearchNode => ({ op: 'leaf', kind: 'regex', value, flags });
const and = (...children: SearchNode[]): SearchNode => ({ op: 'and', children });
const or = (...children: SearchNode[]): SearchNode => ({ op: 'or', children });
const not = (child: SearchNode): SearchNode => ({ op: 'not', child });

const day = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number =>
  new Date(y, mo - 1, d, h, mi, s, ms).getTime();

describe('parseSearch：词项与隐式 AND', () => {
  it('单个词解析成 text 叶子', () => {
    expect(parseSearch('foo')).toEqual({ expr: text('foo'), errors: [] });
  });

  it('空白分隔的相邻词项是隐式 AND', () => {
    expect(parseSearch('foo bar')).toEqual({ expr: and(text('foo'), text('bar')), errors: [] });
  });

  it('三个词的隐式 AND 保持同层扁平结构', () => {
    expect(parseSearch('a b c')).toEqual({ expr: and(text('a'), text('b'), text('c')), errors: [] });
  });

  it('连续空白与首尾空白不产生空叶子', () => {
    expect(parseSearch('   foo    bar   ')).toEqual({ expr: and(text('foo'), text('bar')), errors: [] });
  });

  it('中文词项按普通文本处理', () => {
    expect(parseSearch('今天 开会')).toEqual({ expr: and(text('今天'), text('开会')), errors: [] });
  });
});

describe('parseSearch：显式布尔运算符', () => {
  it('AND 与 && 等价', () => {
    expect(parseSearch('foo AND bar')).toEqual({ expr: and(text('foo'), text('bar')), errors: [] });
    expect(parseSearch('foo && bar')).toEqual({ expr: and(text('foo'), text('bar')), errors: [] });
  });

  it('OR 与 || 等价', () => {
    expect(parseSearch('foo OR bar')).toEqual({ expr: or(text('foo'), text('bar')), errors: [] });
    expect(parseSearch('foo || bar')).toEqual({ expr: or(text('foo'), text('bar')), errors: [] });
  });

  it('NOT 与 ! 前缀等价', () => {
    expect(parseSearch('NOT foo')).toEqual({ expr: not(text('foo')), errors: [] });
    expect(parseSearch('!foo')).toEqual({ expr: not(text('foo')), errors: [] });
  });

  it('运算符大小写不敏感', () => {
    expect(parseSearch('foo and bar')).toEqual({ expr: and(text('foo'), text('bar')), errors: [] });
    expect(parseSearch('foo or bar')).toEqual({ expr: or(text('foo'), text('bar')), errors: [] });
    expect(parseSearch('not foo')).toEqual({ expr: not(text('foo')), errors: [] });
  });

  it('连续取反可嵌套', () => {
    expect(parseSearch('NOT NOT foo')).toEqual({ expr: not(not(text('foo'))), errors: [] });
    expect(parseSearch('!!foo')).toEqual({ expr: not(not(text('foo'))), errors: [] });
  });
});

describe('parseSearch：优先级与括号', () => {
  it('AND 比 OR 紧：a OR b AND c = a OR (b AND c)', () => {
    expect(parseSearch('a OR b AND c')).toEqual({ expr: or(text('a'), and(text('b'), text('c'))), errors: [] });
  });

  it('NOT 比 AND 紧：NOT a AND b = (NOT a) AND b', () => {
    expect(parseSearch('NOT a AND b')).toEqual({ expr: and(not(text('a')), text('b')), errors: [] });
  });

  it('括号显式分组覆盖优先级', () => {
    expect(parseSearch('(a OR b) AND c')).toEqual({ expr: and(or(text('a'), text('b')), text('c')), errors: [] });
  });

  it('括号可嵌套多层', () => {
    expect(parseSearch('((a OR b) AND c) OR d')).toEqual({
      expr: or(and(or(text('a'), text('b')), text('c')), text('d')),
      errors: [],
    });
  });

  it('括号内的隐式 AND 照常生效', () => {
    expect(parseSearch('(a b) OR c')).toEqual({ expr: or(and(text('a'), text('b')), text('c')), errors: [] });
  });

  it('括号缺右括号时到末尾收口，不抛异常', () => {
    expect(parseSearch('(a OR b')).toEqual({ expr: or(text('a'), text('b')), errors: [] });
  });

  it('NOT 作用在括号分组上', () => {
    expect(parseSearch('NOT (a OR b)')).toEqual({ expr: not(or(text('a'), text('b'))), errors: [] });
  });
});

describe('parseSearch：引号词项', () => {
  it('双引号内的空格不拆词', () => {
    expect(parseSearch('"hello world"')).toEqual({ expr: text('hello world'), errors: [] });
  });

  it('引号词项可与普通词项混用', () => {
    expect(parseSearch('foo "bar baz"')).toEqual({ expr: and(text('foo'), text('bar baz')), errors: [] });
  });

  it('引号里的 AND/OR/NOT 只是普通文本', () => {
    expect(parseSearch('"AND"')).toEqual({ expr: text('AND'), errors: [] });
    expect(parseSearch('"OR"')).toEqual({ expr: text('OR'), errors: [] });
    expect(parseSearch('"NOT"')).toEqual({ expr: text('NOT'), errors: [] });
    expect(parseSearch('a "b AND c"')).toEqual({ expr: and(text('a'), text('b AND c')), errors: [] });
  });

  it('未闭合引号：剩余全部当作一个词项并记 errors', () => {
    const spec = parseSearch('"hello world');
    expect(spec.expr).toEqual(text('hello world'));
    expect(spec.errors).toEqual(['unclosed-quote: hello world']);
  });

  it('未闭合引号不影响它前面的词项', () => {
    const spec = parseSearch('foo "bar');
    expect(spec.expr).toEqual(and(text('foo'), text('bar')));
    expect(spec.errors.length).toBe(1);
  });
});

describe('parseSearch：正则', () => {
  it('/pattern/flags 写法', () => {
    expect(parseSearch('/^http/i')).toEqual({ expr: re('^http', 'i'), errors: [] });
  });

  it('re: 写法', () => {
    expect(parseSearch('re:^\\d{3}')).toEqual({ expr: re('^\\d{3}'), errors: [] });
  });

  it('只保留 i 与 u，其余 flag 忽略', () => {
    expect(parseSearch('/abc/gims')).toEqual({ expr: re('abc', 'i'), errors: [] });
    expect(parseSearch('/abc/u')).toEqual({ expr: re('abc', 'u'), errors: [] });
  });

  it('非法正则降级成 text 叶子并记 errors（不抛）', () => {
    const spec = parseSearch('/a[/');
    expect(spec.expr).toEqual(text('a['));
    expect(spec.errors).toEqual(['invalid-regex: a[']);
  });

  it('re: 的非法正则同样降级，value 去掉 re: 前缀', () => {
    const spec = parseSearch('re:a[');
    expect(spec.expr).toEqual(text('a['));
    expect(spec.errors).toEqual(['invalid-regex: a[']);
  });

  it('像路径的斜杠词项不当正则（/usr/local/bin 按字面搜）', () => {
    expect(parseSearch('/usr/local/bin')).toEqual({ expr: text('/usr/local/bin'), errors: [] });
    expect(parseSearch('/foo/bar')).toEqual({ expr: text('/foo/bar'), errors: [] });
  });

  it('正则叶子可与其它词项组合', () => {
    expect(parseSearch('foo AND /bar/i')).toEqual({ expr: and(text('foo'), re('bar', 'i')), errors: [] });
  });
});

describe('parseSearch：时间范围', () => {
  it('after: 取该日本地 00:00:00.000', () => {
    expect(parseSearch('after:2024-01-01')).toEqual({ time: { from: day(2024, 1, 1) }, errors: [] });
  });

  it('before: 取该日本地 23:59:59.999', () => {
    expect(parseSearch('before:2024-12-31')).toEqual({ time: { to: day(2024, 12, 31, 23, 59, 59, 999) }, errors: [] });
  });

  it('after/before 可同时出现', () => {
    expect(parseSearch('after:2024-01-01 before:2024-12-31')).toEqual({
      time: { from: day(2024, 1, 1), to: day(2024, 12, 31, 23, 59, 59, 999) },
      errors: [],
    });
  });

  it('带时刻的 after: 取该分钟起点', () => {
    expect(parseSearch('after:2024-03-05T08:30')).toEqual({ time: { from: day(2024, 3, 5, 8, 30) }, errors: [] });
  });

  it('带时刻的 before: 取该分钟终点', () => {
    expect(parseSearch('before:2024-03-05T08:30')).toEqual({
      time: { to: day(2024, 3, 5, 8, 30, 59, 999) },
      errors: [],
    });
  });

  it('after:/before: 本身不作为关键词参与匹配', () => {
    expect(parseSearch('foo after:2024-01-01 bar')).toEqual({
      expr: and(text('foo'), text('bar')),
      time: { from: day(2024, 1, 1) },
      errors: [],
    });
  });

  it('不存在的日期被忽略并记 errors（2024-02-31）', () => {
    const spec = parseSearch('after:2024-02-31');
    expect(spec.time).toBeUndefined();
    expect(spec.errors).toEqual(['invalid-date: 2024-02-31']);
  });

  it('格式错误的日期被忽略并记 errors', () => {
    const spec = parseSearch('before:2024/12/31');
    expect(spec.time).toBeUndefined();
    expect(spec.errors).toEqual(['invalid-date: 2024/12/31']);
  });

  it('时间写错不影响其它关键词', () => {
    const spec = parseSearch('foo before:2024-13-01');
    expect(spec.expr).toEqual(text('foo'));
    expect(spec.time).toBeUndefined();
    expect(spec.errors).toEqual(['invalid-date: 2024-13-01']);
  });
});

describe('parseSearch：空输入与孤立运算符', () => {
  it('空输入不产生任何条件', () => {
    expect(parseSearch('')).toEqual({ errors: [] });
  });

  it('只有空白不产生任何条件', () => {
    expect(parseSearch('   \t  ')).toEqual({ errors: [] });
  });

  it('只有 AND 时运算符被忽略', () => {
    expect(parseSearch('AND')).toEqual({ errors: [] });
  });

  it('只有 OR / NOT 时运算符被忽略', () => {
    expect(parseSearch('OR')).toEqual({ errors: [] });
    expect(parseSearch('NOT')).toEqual({ errors: [] });
    expect(parseSearch('&& || !')).toEqual({ errors: [] });
  });

  it('尾部悬空运算符被丢弃', () => {
    expect(parseSearch('foo AND')).toEqual({ expr: text('foo'), errors: [] });
    expect(parseSearch('foo OR')).toEqual({ expr: text('foo'), errors: [] });
    expect(parseSearch('foo NOT')).toEqual({ expr: text('foo'), errors: [] });
  });

  it('贴在一起的 && 仍按字面文本处理（不拆运算符）', () => {
    expect(parseSearch('a&&b')).toEqual({ expr: text('a&&b'), errors: [] });
  });

  it('重复运算符被丢弃而不产生非法节点', () => {
    expect(parseSearch('a AND AND b')).toEqual({ expr: and(text('a'), text('b')), errors: [] });
  });

  it('只有括号时没有叶子', () => {
    expect(parseSearch('()')).toEqual({ errors: [] });
  });
});

describe('matchSearch：三路 LIKE 语义', () => {
  it('命中原文', () => {
    expect(matchSearch(text('开会'), { text: '今天下午开会', searchIndex: '' })).toBe(true);
  });

  it('命中拼音索引列', () => {
    expect(matchSearch(text('kaihui'), { text: '今天下午开会', searchIndex: 'jintian xiawu kaihui' })).toBe(true);
  });

  it('命中图片尺寸描述', () => {
    expect(matchSearch(text('1920x1080'), { text: '截图', searchIndex: '', imageDesc: '1920x1080 png' })).toBe(true);
  });

  it('三路都不含时返回 false', () => {
    expect(matchSearch(text('zzz'), { text: 'abc', searchIndex: 'def', imageDesc: 'ghi' })).toBe(false);
  });

  it('大小写不敏感（等价 SQLite LIKE）', () => {
    expect(matchSearch(text('HELLO'), { text: 'hello world', searchIndex: '' })).toBe(true);
    expect(matchSearch(text('hello'), { text: 'HELLO WORLD', searchIndex: '' })).toBe(true);
  });

  it('imageDesc 缺省不抛异常', () => {
    expect(matchSearch(text('abc'), { text: 'abc', searchIndex: '' })).toBe(true);
    expect(matchSearch(text('xyz'), { text: 'abc', searchIndex: '' })).toBe(false);
  });

  it('空 value 视为命中（健壮性）', () => {
    expect(matchSearch(text(''), { text: 'abc', searchIndex: '' })).toBe(true);
  });

  it('expr 为 undefined 时返回 true', () => {
    expect(matchSearch(undefined, { text: 'abc', searchIndex: '' })).toBe(true);
  });
});

describe('matchSearch：正则语义', () => {
  it('不带 i 时区分大小写', () => {
    expect(matchSearch(re('^abc'), { text: 'abcdef', searchIndex: '' })).toBe(true);
    expect(matchSearch(re('^ABC'), { text: 'abcdef', searchIndex: '' })).toBe(false);
  });

  it('带 i 时忽略大小写', () => {
    expect(matchSearch(re('^ABC', 'i'), { text: 'abcdef', searchIndex: '' })).toBe(true);
  });

  it('正则同时匹配三路字段', () => {
    expect(matchSearch(re('kaihui'), { text: '开会', searchIndex: 'kaihui' })).toBe(true);
    expect(matchSearch(re('1920'), { text: '截图', searchIndex: '', imageDesc: '1920x1080' })).toBe(true);
  });

  it('重复求值结果稳定（不受 lastIndex 影响）', () => {
    const leaf = re('a', 'i');
    const fields = { text: 'aaa', searchIndex: '' };
    expect(matchSearch(leaf, fields)).toBe(true);
    expect(matchSearch(leaf, fields)).toBe(true);
    expect(matchSearch(leaf, fields)).toBe(true);
  });

  it('构造失败的正则返回 false', () => {
    expect(matchSearch(re('a['), { text: 'a[', searchIndex: '' })).toBe(false);
  });
});

describe('matchSearch：布尔组合', () => {
  const fields = { text: '今天下午三点开会', searchIndex: 'jintian xiawu sandian kaihui', imageDesc: '1280x720' };

  it('and 需要全部子节点命中', () => {
    expect(matchSearch(and(text('开会'), text('jintian')), fields)).toBe(true);
    expect(matchSearch(and(text('开会'), text('明天')), fields)).toBe(false);
  });

  it('or 任一子节点命中即可', () => {
    expect(matchSearch(or(text('明天'), text('sandian')), fields)).toBe(true);
    expect(matchSearch(or(text('明天'), text('后天')), fields)).toBe(false);
  });

  it('not 取反', () => {
    expect(matchSearch(not(text('明天')), fields)).toBe(true);
    expect(matchSearch(not(text('开会')), fields)).toBe(false);
  });

  it('优先级在求值阶段同样成立：a OR b AND c', () => {
    const expr = parseSearch('1280 OR 明天 AND 后天').expr;
    expect(matchSearch(expr, fields)).toBe(true);
  });

  it('解析结果与求值串起来可用', () => {
    const expr = parseSearch('"今天" AND NOT 明天 AND /kai/i').expr;
    expect(matchSearch(expr, fields)).toBe(true);
    const miss = parseSearch('"今天" AND 明天').expr;
    expect(matchSearch(miss, fields)).toBe(false);
  });
});
