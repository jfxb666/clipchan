/**
 * 链接预览的纯逻辑：URL 归一化、域名提取、站点图标推导、HTML meta 提取、可抓取性判断。
 *
 * ★ 本文件零依赖、零 import、不发任何网络请求，也不碰 electron/node。
 *   真正的抓取在主进程里做，这里只回答三个问题：该不该抓、抓哪些地址、抓回来怎么认标题。
 */

/** ★ 超过这个长度的东西基本不是用户想预览的链接，一律当噪声丢掉。 */
const MAX_URL_LENGTH = 2048;

/** ★ 标题/描述的上限：列表卡片放不下更长的东西，超长只会撑爆布局。 */
const MAX_META_LENGTH = 300;

/** 协议前缀：字母开头，后面允许 +.- 和数字（RFC 3986 的 scheme 文法）。 */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** meta 标签：用 [^>]* 而不是 (.*?)，既线性又不会写出嵌套量词。 */
const META_TAG_RE = /<meta\b[^>]*>/gi;

/** 标签属性：支持单引号、双引号、无引号三种取值，属性顺序任意。 */
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** <title> 标签：惰性匹配，非嵌套量词，1MB 无匹配也是线性扫描。 */
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

/** HTML 实体：十进制 / 十六进制 / 具名，三选一，长度都做了上界。 */
const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,7}));/g;

/** ★ 只收常见的具名实体：标题里出现生僻实体名的概率极低，收了也白收。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
};

/** 取 authority 的结束位置（第一个 / ? # 的位置，没有就是末尾）。手写循环，不用正则。 */
function delimiterIndex(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '/' || ch === '?' || ch === '#') return i;
  }
  return text.length;
}

/**
 * 只把 authority 里的主机名小写化，用户信息与端口原样保留。
 * ★ 不用 URL 序列化的结果，因为那会顺手改写路径（补斜杠、百分号编码、丢默认端口），
 *   而本函数输出的字符串同时是缓存主键，任何多余改写都会让历史缓存查不到。
 */
function lowercaseHost(authority: string): string {
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at + 1) : '';
  const hostPort = authority.slice(at + 1);
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) return authority;
    return userinfo + hostPort.slice(0, close + 1).toLowerCase() + hostPort.slice(close + 1);
  }
  const colon = hostPort.lastIndexOf(':');
  if (colon >= 0) return userinfo + hostPort.slice(0, colon).toLowerCase() + hostPort.slice(colon);
  return userinfo + hostPort.toLowerCase();
}

/** 归一化后的 URL；无法归一化时返回 null。 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_URL_LENGTH) return null;
  // ★ 带空格/换行的"URL"多半是误判的正文，抓了也是错的，直接判死。
  if (/\s/.test(trimmed)) return null;

  let candidate: string;
  const schemeMatch = SCHEME_RE.exec(trimmed);
  if (schemeMatch === null) {
    // 无协议：只补 https，其余原样。
    candidate = 'https://' + trimmed;
  } else {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      candidate = trimmed;
    } else if (scheme.includes('.') || /^\d/.test(trimmed.slice(schemeMatch[0].length))) {
      // ★ 'example.com:8080/a' 冒号左边是主机名不是协议；'localhost:3000' 同理（端口是数字）。
      candidate = 'https://' + trimmed;
    } else {
      // ftp / file / mailto / javascript / data ... 一律不认。
      return null;
    }
  }

  const sep = candidate.indexOf('://');
  if (sep < 0) return null;
  const rest = candidate.slice(sep + 3);
  const cut = delimiterIndex(rest);
  const authority = rest.slice(0, cut);
  if (authority.length === 0) return null;

  // ★ 用 URL 做最终校验（畸形端口、非法字符等），但不用它的序列化结果。
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.hostname.length === 0) return null;

  // ★ 唯一允许的两处改写：协议名小写、主机名小写。
  //   路径、查询串、#fragment、末尾斜杠全部原样保留——这是缓存主键，改了历史缓存就查不到。
  return candidate.slice(0, sep).toLowerCase() + '://' + lowercaseHost(authority) + rest.slice(cut);
}

/** 主机名（小写、去掉 www. 前缀）；解析不出时返回 ''。 */
export function domainOf(url: string): string {
  const normalized = normalizeUrl(url);
  if (normalized === null) return '';
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** 站点图标候选地址（按优先级，最多 2 个）。 */
export function faviconCandidates(url: string): string[] {
  const normalized = normalizeUrl(url);
  if (normalized === null) return [];
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return [];
  }
  // ★ 用 hostname 而不是 host：图标走 https，带非 80/443 端口拼出来的地址必然连不上。
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return [];

  const out: string[] = ['https://' + host + '/favicon.ico'];
  const domain = domainOf(normalized);
  if (domain.length > 0) {
    // ★ 第二个是公共免 Key 的第三方服务，只在本地直连失败时兜底。
    //   本项目承诺零服务器依赖，所以它只是一个普通的外部 URL：主进程抓不到就算了，
    //   绝不上报任何东西，也不把它当成本项目自建的服务。
    out.push('https://www.google.com/s2/favicons?domain=' + domain + '&sz=64');
  }
  return out;
}

/** 从 HTML 里提取标题与描述。 */
export interface PageMeta {
  title: string;
  description: string;
}

/** 把数字码点转成字符；越界或非法就退回原文。 */
function codePointToString(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** 单趟解码 HTML 实体：先解一次就不会出现"解两遍"的重复解码问题。 */
function decodeEntities(text: string): string {
  if (text.indexOf('&') < 0) return text;
  return text.replace(
    ENTITY_RE,
    (whole: string, dec: string, hex: string, name: string): string => {
      if (dec) return codePointToString(Number.parseInt(dec, 10), whole);
      if (hex) return codePointToString(Number.parseInt(hex, 16), whole);
      if (name) {
        const mapped = NAMED_ENTITIES[name.toLowerCase()];
        if (mapped !== undefined) return mapped;
      }
      return whole;
    },
  );
}

/** trim + 折叠连续空白 + 截断。 */
function cleanText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_META_LENGTH ? flat.slice(0, MAX_META_LENGTH) : flat;
}

/** 把一个标签里的属性读成 map（同名属性以第一个为准）。 */
function parseAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(ATTR_RE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name.length === 0) continue;
    if (!attrs.has(name)) attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * 从 HTML 里提取标题与描述。
 * ★ 刻意不写完整 HTML 解析器：我们只要 og:title / og:description / description / <title>，
 *   正则扫描比引一个 DOM 实现便宜几个数量级，也不怕畸形 HTML。
 *   代价是 <script> 字符串里的假 meta 也会被认出来——这个取舍可以接受。
 */
export function extractMeta(html: string): PageMeta {
  let ogTitle = '';
  let ogDescription = '';
  let nameDescription = '';
  let titleTag = '';

  if (html.length > 0) {
    for (const tag of html.match(META_TAG_RE) ?? []) {
      const attrs = parseAttrs(tag);
      const content = attrs.get('content') ?? '';
      if (content.length === 0) continue;
      // 属性顺序任意：先收进 map，再按语义取，content 写在前面也一样认得出。
      const property = (attrs.get('property') ?? '').trim().toLowerCase();
      const name = (attrs.get('name') ?? '').trim().toLowerCase();
      if (ogTitle.length === 0 && (property === 'og:title' || name === 'og:title')) ogTitle = content;
      if (ogDescription.length === 0 && (property === 'og:description' || name === 'og:description')) {
        ogDescription = content;
      }
      if (nameDescription.length === 0 && name === 'description') nameDescription = content;
    }
    const titleMatch = TITLE_RE.exec(html);
    if (titleMatch !== null) titleTag = titleMatch[1] ?? '';
  }

  // 优先级：og:title > <title>；og:description > meta[name=description]。
  const title = cleanText(decodeEntities(ogTitle.length > 0 ? ogTitle : titleTag));
  const description = cleanText(decodeEntities(ogDescription.length > 0 ? ogDescription : nameDescription));
  return { title, description };
}

/**
 * 这个链接值不值得抓（跳过本机地址、内网、非 http(s)、过长的 data: 等）。
 * ★ 判断全在字符串上做，不查 DNS：解析域名要发网络请求，而本函数必须在零网络前提下给出答案。
 *   所以像 http://example.local/ 这种"只有 DNS 才知道是内网"的域名，靠后缀规则兜住。
 */
export function shouldFetchUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return false;

  const normalized = normalizeUrl(trimmed);
  if (normalized === null) return false;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return false;
  // IPv6 字面量（含 [::1]）：URL 会把方括号一起留在 hostname 里。
  if (host.startsWith('[')) return false;
  if (host === 'localhost') return false;
  if (host === '0.0.0.0') return false;
  // ★ 整个 127/8 都是环回，不只是 127.0.0.1。
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.endsWith('.local')) return false;
  // ★ 不含点的主机名（intranet、nas、localhost）都不是公网可抓的站点。
  if (!host.includes('.')) return false;
  return true;
}
