/**
 * 搜索语法解析与求值 —— 纯逻辑层（不碰数据库、不碰 Electron）。
 *
 * ============================ 给用户看的一页说明 ============================
 * 在搜索框里可以这样写：
 *
 * 1) 多个词：空格分隔，相邻词是「并且」的关系。
 *      foo bar         → 同时包含 foo 和 bar
 *
 * 2) 布尔运算（大小写不敏感）：
 *      AND / &&        并且
 *      OR  / ||        或者
 *      NOT / !         取反（写在词前面，例如 NOT 图片 或 !图片）
 *    例：foo AND bar、foo || bar、NOT 草稿
 *
 * 3) 优先级：NOT > AND > OR。想改变顺序就加括号。
 *      a OR b AND c    = a OR (b AND c)
 *      (a OR b) AND c  括号优先，可嵌套
 *
 * 4) 带空格的整词用双引号包起来：
 *      "hello world"   当成一个词
 *    引号里的 AND / OR / NOT 只是普通文字。
 *    引号没闭合：从引号到结尾都当成一个词，并在 errors 里留一条提示（不报错）。
 *
 * 5) 正则：/pattern/flags 或 re:pattern，flags 只认 i（忽略大小写）和 u。
 *      /^https?:\/\//i      re:^\d{3}
 *    正则写错了不会报错，会退化成普通文字搜索，并在 errors 里留一条提示。
 *    注意 /.../ 必须是独立的一个词（后面紧跟空格、括号或结尾）才算正则，
 *    所以 /usr/local/bin 这种路径仍然按普通文字搜。
 *
 * 6) 时间范围：
 *      after:2024-01-01            该日（本地时间）00:00:00.000 之后
 *      before:2024-12-31           该日（本地时间）23:59:59.999 之前
 *      after:2024-03-05T08:30      精确到分钟（after 取该分钟起点，before 取该分钟终点）
 *    日期写错了：忽略这一段并记一条 errors，其余关键词照常生效。
 *    after:/before: 本身不算关键词。
 *
 * 7) 什么都没写（或只有空白）→ 没有任何条件。
 *
 * 8) 只写了运算符（例如只输入 AND）→ 运算符被忽略，不会产生非法条件。
 *
 * 9) 最基础的叶子仍然是原来的三路 LIKE：原文 / 拼音索引 / 图片尺寸描述，
 *    任一路包含就算命中（大小写不敏感）。
 * ==========================================================================
 */

/** 布尔表达式节点。叶子只有两种：三路文本匹配 / 正则匹配。 */
export type SearchNode =
  | { op: 'leaf'; kind: 'text'; value: string }
  | { op: 'leaf'; kind: 'regex'; value: string; flags: string }
  | { op: 'and'; children: SearchNode[] }
  | { op: 'or'; children: SearchNode[] }
  | { op: 'not'; child: SearchNode };

/** 时间范围（毫秒时间戳，含端点；缺省表示该侧不限制）。 */
export interface SearchTimeRange {
  from?: number;
  to?: number;
}

export interface SearchSpec {
  /** 布尔表达式；没有关键词条件时为 undefined。 */
  expr?: SearchNode;
  time?: SearchTimeRange;
  /** 语法层面被识别但没用上的片段（如非法正则），供界面回显；正常查询为空数组。 */
  errors: string[];
}

/** 三路 LIKE 的字段：原文 / 预建拼音列 / 图片尺寸描述。 */
interface SearchFields {
  text: string;
  searchIndex: string;
  imageDesc?: string;
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

type Token =
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'and' }
  | { t: 'or' }
  | { t: 'not' }
  | { t: 'text'; value: string }
  | { t: 'regex'; value: string; flags: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/** JS 认识的 flag 字符。不在此列的词项不当正则，避免把 /usr/local 这类路径吃掉。 */
const REGEX_FLAG_CHARS = 'dgimsuvy';

function isFlagChar(ch: string): boolean {
  return REGEX_FLAG_CHARS.includes(ch);
}

/** 只保留 i / u 两个有意义的 flag（其余忽略），并按出现顺序去重。 */
function normalizeFlags(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if ((ch === 'i' || ch === 'u') && !out.includes(ch)) out += ch;
  }
  return out;
}

/**
 * ★ 真正传给 RegExp 的 flag 只有 i：u 在 flags 里被记录（界面回显用），
 * 但求值时不带 —— 保证「解析时能构造」与「求值时能构造」用的是同一套 flag，
 * 不会出现解析通过、求值抛异常的两套标准。
 */
function regexFlagsForRegExp(flags: string): string {
  return flags.includes('i') ? 'i' : '';
}

function isValidRegex(value: string, flags: string): boolean {
  try {
    new RegExp(value, regexFlagsForRegExp(flags));
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试把 start 处的 / 读成 /pattern/flags。
 * 返回 null 表示「这不像正则」，交给普通词项处理（例如路径 /usr/local/bin）。
 */
function scanSlashRegex(
  input: string,
  start: number,
): { value: string; flags: string; end: number } | null {
  const n = input.length;
  let j = start + 1;
  let value = '';
  let closed = -1;
  while (j < n) {
    const c = input[j]!;
    if (c === '\\' && j + 1 < n) {
      value += c + input[j + 1]!;
      j += 2;
      continue;
    }
    if (c === '/') {
      closed = j;
      break;
    }
    value += c;
    j += 1;
  }
  if (closed < 0) return null;
  // 空 pattern（就是 //）不当正则：那是代码里常见的注释符号，当文字更不意外。
  if (value.length === 0) return null;
  let k = closed + 1;
  let rawFlags = '';
  while (k < n && isFlagChar(input[k]!)) {
    rawFlags += input[k]!;
    k += 1;
  }
  const next = k < n ? input[k]! : '';
  // ★ 收尾后必须紧跟空白 / 括号 / 结尾，且 flags 只能由已知字母组成。
  //   否则 /usr/local、/foo/bar 会被误判成正则，用户想按字面搜路径就搜不到了。
  if (next !== '' && !isSpace(next) && next !== '(' && next !== ')') return null;
  return { value, flags: normalizeFlags(rawFlags), end: k };
}

/**
 * ★ 解析日期边界：after 取该时刻起点，before 取该时刻终点。
 * 为什么 before 取 23:59:59.999：用户说「12-31 之前」，心里想的是包含 12-31 全天；
 * 若取 00:00 会整天漏掉，若取次日 00:00 又会把次日零点整算进来，都不如「当天的最后一毫秒」精确。
 * 另外用 getFullYear/getMonth/getDate 回读校验，挡住 2024-02-31 这种被 JS 顺延成 3 月的假日期。
 */
function parseDateBound(raw: string, isAfter: boolean): number | null {
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const y = Number(m[1] ?? '');
  const mo = Number(m[2] ?? '');
  const d = Number(m[3] ?? '');
  const hasTime = m[4] !== undefined;
  // 不带时刻时：after 取当天起点，before 取当天终点（★ 见上方关于 23:59:59.999 的说明）。
  const h = hasTime ? Number(m[4] ?? '') : isAfter ? 0 : 23;
  const mi = hasTime ? Number(m[5] ?? '') : isAfter ? 0 : 59;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, isAfter ? 0 : 59, isAfter ? 0 : 999);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}

/** 单个词项（不含引号）的分类：运算符 / 时间 / 正则 / 普通文字。 */
function classifyWord(
  raw: string,
  errors: string[],
  applyTime: (raw: string, isAfter: boolean) => void,
): Token | null {
  const upper = raw.toUpperCase();
  if (upper === 'AND' || raw === '&&') return { t: 'and' };
  if (upper === 'OR' || raw === '||') return { t: 'or' };
  if (upper === 'NOT' || raw === '!') return { t: 'not' };

  const lower = raw.toLowerCase();
  if (lower.startsWith('after:')) {
    applyTime(raw, true);
    return null;
  }
  if (lower.startsWith('before:')) {
    applyTime(raw, false);
    return null;
  }
  if (lower.startsWith('re:')) {
    const body = raw.slice(3);
    if (body.length === 0) return null;
    /**
     * ★ 为什么非法正则降级成文字而不是抛异常：
     * 搜索框是「边打边搜」的，用户输入 /a[/ 的中间态（少一个右括号）随时会出现；
     * 抛异常会让整条查询失效、界面还得接异常分支。降级成文字至少还能命中字面量，
     * 同时把原因写进 errors 供界面提示，用户改一个字符就恢复成正则。
     */
    if (!isValidRegex(body, '')) {
      errors.push('invalid-regex: ' + body);
      return { t: 'text', value: body };
    }
    return { t: 'regex', value: body, flags: '' };
  }
  return { t: 'text', value: raw };
}

function lex(input: string, errors: string[]): { tokens: Token[]; time?: SearchTimeRange } {
  const tokens: Token[] = [];
  let time: SearchTimeRange | undefined;
  const n = input.length;
  let i = 0;

  const applyTime = (raw: string, isAfter: boolean): void => {
    // 'after:' 6 个字符，'before:' 7 个字符。
    const value = raw.slice(isAfter ? 6 : 7).trim();
    const ms = parseDateBound(value, isAfter);
    if (ms === null) {
      errors.push('invalid-date: ' + value);
      return;
    }
    time ??= {};
    if (isAfter) time.from = ms;
    else time.to = ms;
  };

  while (i < n) {
    const ch = input[i]!;
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ t: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ t: 'rparen' });
      i += 1;
      continue;
    }
    // ★ 引号里的内容一律当普通文字：连 after: / re: / AND 都不再解释。
    //   引号的意思就是「我要字面量」，这样规则 9（引号里的 AND 当文本）自然成立，
    //   也不必为每种语法各写一条特例。
    if (ch === '"') {
      const close = input.indexOf('"', i + 1);
      if (close < 0) {
        const rest = input.slice(i + 1);
        errors.push('unclosed-quote: ' + rest);
        if (rest.length > 0) tokens.push({ t: 'text', value: rest });
        i = n;
        continue;
      }
      const body = input.slice(i + 1, close);
      if (body.length > 0) tokens.push({ t: 'text', value: body });
      i = close + 1;
      continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      tokens.push({ t: 'and' });
      i += 2;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      tokens.push({ t: 'or' });
      i += 2;
      continue;
    }
    if (ch === '!') {
      tokens.push({ t: 'not' });
      i += 1;
      continue;
    }
    if (ch === '/') {
      const scanned = scanSlashRegex(input, i);
      if (scanned) {
        i = scanned.end;
        if (isValidRegex(scanned.value, scanned.flags)) {
          tokens.push({ t: 'regex', value: scanned.value, flags: scanned.flags });
        } else {
          // ★ 同上：降级成文字，value 用去掉 /…/ 外壳后的 pattern 原文。
          errors.push('invalid-regex: ' + scanned.value);
          tokens.push({ t: 'text', value: scanned.value });
        }
        continue;
      }
    }

    // 普通词项：到空白 / 括号 / 引号为止。
    // ★ & | ! 不作为词内终止符：剪贴板里常有代码片段，a&&b 应该还能按字面搜；
    //   运算符只在「独立成词」或「位于词首」时生效。
    let j = i;
    while (j < n) {
      const c = input[j]!;
      if (isSpace(c) || c === '(' || c === ')' || c === '"') break;
      j += 1;
    }
    if (j === i) {
      i += 1;
      continue;
    }
    const raw = input.slice(i, j);
    i = j;
    const token = classifyWord(raw, errors, applyTime);
    if (token) tokens.push(token);
  }

  return time ? { tokens, time } : { tokens };
}

// ---------------------------------------------------------------------------
// 语法分析（递归下降：NOT > AND > OR）
// ---------------------------------------------------------------------------

function parseTokens(tokens: Token[]): SearchNode | undefined {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  const startsOperand = (t: Token | undefined): boolean => {
    if (!t) return false;
    return t.t === 'text' || t.t === 'regex' || t.t === 'lparen' || t.t === 'not';
  };

  const parsePrimary = (): SearchNode | undefined => {
    const t = peek();
    if (!t) return undefined;
    if (t.t === 'lparen') {
      pos += 1;
      const inner = parseOr();
      // ★ 括号不配对时宽容处理：缺右括号就到末尾收口，多余右括号由上层忽略。
      if (peek()?.t === 'rparen') pos += 1;
      return inner;
    }
    if (t.t === 'text') {
      pos += 1;
      return { op: 'leaf', kind: 'text', value: t.value };
    }
    if (t.t === 'regex') {
      pos += 1;
      return { op: 'leaf', kind: 'regex', value: t.value, flags: t.flags };
    }
    return undefined;
  };

  const parseNot = (): SearchNode | undefined => {
    if (peek()?.t === 'not') {
      pos += 1;
      const child = parseNot();
      // ★ 规则 8：孤立运算符不产生节点，也不报错（NOT 后面没东西就整体忽略）。
      if (!child) return undefined;
      return { op: 'not', child };
    }
    return parsePrimary();
  };

  const parseAnd = (): SearchNode | undefined => {
    // 吞掉这一层开头的孤立 AND/OR（例如 OR a、a OR OR b）。
    while (peek()?.t === 'and' || peek()?.t === 'or') pos += 1;
    const parts: SearchNode[] = [];
    const first = parseNot();
    if (first) parts.push(first);
    for (;;) {
      const t = peek();
      if (t && t.t === 'and') {
        pos += 1;
        const rhs = parseNot();
        if (rhs) parts.push(rhs);
        continue;
      }
      // 隐式 AND：下一个 token 能开始一个操作数就接着收。
      if (startsOperand(t)) {
        const rhs = parseNot();
        if (rhs) parts.push(rhs);
        continue;
      }
      break;
    }
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0]!;
    return { op: 'and', children: parts };
  };

  function parseOr(): SearchNode | undefined {
    const parts: SearchNode[] = [];
    const first = parseAnd();
    if (first) parts.push(first);
    while (peek()?.t === 'or') {
      pos += 1;
      const rhs = parseAnd();
      if (rhs) parts.push(rhs);
    }
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0]!;
    return { op: 'or', children: parts };
  }

  return parseOr();
}

/** 把用户输入的一行搜索词解析成结构化规格。永不抛异常。 */
export function parseSearch(input: string): SearchSpec {
  const errors: string[] = [];
  try {
    const source = typeof input === 'string' ? input : '';
    const lexed = lex(source, errors);
    const expr = parseTokens(lexed.tokens);
    const spec: SearchSpec = { errors };
    if (expr) spec.expr = expr;
    if (lexed.time) spec.time = lexed.time;
    return spec;
  } catch (e) {
    errors.push('parse-failed: ' + (e instanceof Error ? e.message : String(e)));
    return { errors };
  }
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

function collectFields(fields: SearchFields): string[] {
  const out: string[] = [];
  const raw = [fields.text, fields.searchIndex, fields.imageDesc];
  for (const v of raw) {
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

/** 三路任一包含即命中，等价 SQLite 的 LIKE '%v%'（大小写不敏感）。 */
function matchTextLeaf(value: string, fields: SearchFields): boolean {
  if (value.length === 0) return true;
  const needle = value.toLowerCase();
  for (const v of collectFields(fields)) {
    if (v.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function matchRegexLeaf(value: string, flags: string, fields: SearchFields): boolean {
  let re: RegExp;
  try {
    // ★ 永远不带 g/y：带 g 的 RegExp 有 lastIndex 状态，多次 .test 会忽真忽假。
    re = new RegExp(value, regexFlagsForRegExp(flags));
  } catch {
    return false;
  }
  for (const v of collectFields(fields)) {
    if (re.test(v)) return true;
  }
  return false;
}

/** 纯求值：给定一条记录的三路字段，判断是否命中表达式。expr 为 undefined 时返回 true。 */
export function matchSearch(
  expr: SearchNode | undefined,
  fields: { text: string; searchIndex: string; imageDesc?: string },
): boolean {
  if (!expr) return true;
  const safe: SearchFields = fields ?? { text: '', searchIndex: '' };
  if (expr.op === 'leaf') {
    return expr.kind === 'text'
      ? matchTextLeaf(expr.value, safe)
      : matchRegexLeaf(expr.value, expr.flags, safe);
  }
  if (expr.op === 'and') return expr.children.every((c) => matchSearch(c, safe));
  if (expr.op === 'or') return expr.children.some((c) => matchSearch(c, safe));
  return !matchSearch(expr.child, safe);
}
