import { describe, expect, it } from 'vitest';
import { domainOf, extractMeta, faviconCandidates, normalizeUrl, shouldFetchUrl } from './urlPreview';

describe('normalizeUrl', () => {
  it('无协议时补 https', () => {
    expect(normalizeUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('已有 http/https 时保留协议只做小写化', () => {
    expect(normalizeUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(normalizeUrl('HTTPS://example.com/a')).toBe('https://example.com/a');
  });

  it('先 trim 首尾空白与换行', () => {
    expect(normalizeUrl('  https://example.com/a\n ')).toBe('https://example.com/a');
  });

  it('保留末尾斜杠（缓存主键不能改）', () => {
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com/');
    expect(normalizeUrl('https://a.com')).toBe('https://a.com');
  });

  it('保留 #fragment 原样（缓存主键不能改）', () => {
    expect(normalizeUrl('https://a.com/x#Sec-2')).toBe('https://a.com/x#Sec-2');
  });

  it('路径与查询串大小写原样保留，只有主机名小写', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/A')).toBe('https://example.com/A');
    expect(normalizeUrl('https://Example.COM/A?Q=Value')).toBe('https://example.com/A?Q=Value');
  });

  it('空串与纯空白返回 null', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   \n\t ')).toBeNull();
  });

  it('非 http(s) 协议一律 null', () => {
    expect(normalizeUrl('ftp://example.com/a')).toBeNull();
    expect(normalizeUrl('file:///c:/a.txt')).toBeNull();
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,<b>x</b>')).toBeNull();
  });

  it('主机名为空时 null', () => {
    expect(normalizeUrl('https://')).toBeNull();
    expect(normalizeUrl('https:///a')).toBeNull();
  });

  it('含空格或换行的 URL 判死', () => {
    expect(normalizeUrl('https://a.com/a b')).toBeNull();
    expect(normalizeUrl('https://a.com/a\nb')).toBeNull();
  });

  it('超过 2048 字符判死', () => {
    expect(normalizeUrl('https://a.com/' + 'x'.repeat(2048))).toBeNull();
    expect(normalizeUrl('https://a.com/' + 'x'.repeat(2000))).not.toBeNull();
  });

  it('无协议但带端口的主机名不会被误认成协议', () => {
    expect(normalizeUrl('example.com:8080/a')).toBe('https://example.com:8080/a');
  });

  it('非法字符由 URL 校验拦下', () => {
    expect(normalizeUrl('https://exa mple.com/')).toBeNull();
    expect(normalizeUrl('https://exa%zzmple.com/')).toBeNull();
  });

  it('非法端口由 URL 校验拦下', () => {
    expect(normalizeUrl('https://a.com:99999999/')).toBeNull();
    expect(normalizeUrl('https://a.com:abc/')).toBeNull();
  });

  it('保留端口与用户信息，只小写主机名', () => {
    expect(normalizeUrl('https://User:Pw@EXAMPLE.COM:8443/A')).toBe('https://User:Pw@example.com:8443/A');
  });
});

describe('domainOf', () => {
  it('去掉 www. 前缀', () => {
    expect(domainOf('https://www.example.com/a')).toBe('example.com');
  });

  it('去掉端口', () => {
    expect(domainOf('https://sub.example.com:8080/a')).toBe('sub.example.com');
  });

  it('主机名小写化', () => {
    expect(domainOf('https://WWW.Example.COM/a')).toBe('example.com');
  });

  it('无协议输入也能解析', () => {
    expect(domainOf('example.com/a')).toBe('example.com');
  });

  it('非法输入返回空串', () => {
    expect(domainOf('')).toBe('');
    expect(domainOf('   ')).toBe('');
    expect(domainOf('mailto:a@b.com')).toBe('');
    expect(domainOf('https://')).toBe('');
  });
});

describe('faviconCandidates', () => {
  it('给出两个候选：站点自身 favicon 在前，第三方兜底在后', () => {
    expect(faviconCandidates('https://www.example.com/a')).toEqual([
      'https://www.example.com/favicon.ico',
      'https://www.google.com/s2/favicons?domain=example.com&sz=64',
    ]);
  });

  it('第二个候选的 domain 去 www. 且不带端口', () => {
    expect(faviconCandidates('https://sub.example.com:8080/a')[1]).toBe(
      'https://www.google.com/s2/favicons?domain=sub.example.com&sz=64',
    );
  });

  it('第一个候选不带端口', () => {
    expect(faviconCandidates('https://sub.example.com:8080/a')[0]).toBe(
      'https://sub.example.com/favicon.ico',
    );
  });

  it('最多 2 个', () => {
    expect(faviconCandidates('https://example.com/a').length).toBe(2);
  });

  it('非法 URL 返回空数组', () => {
    expect(faviconCandidates('')).toEqual([]);
    expect(faviconCandidates('ftp://a.com/x')).toEqual([]);
    expect(faviconCandidates('https://')).toEqual([]);
  });
});

describe('extractMeta', () => {
  it('优先 og:title 与 og:description', () => {
    const html =
      '<html><head><title>网页标题</title>' +
      '<meta property="og:title" content="OG 标题">' +
      '<meta property="og:description" content="OG 描述">' +
      '<meta name="description" content="普通描述">' +
      '</head></html>';
    expect(extractMeta(html)).toEqual({ title: 'OG 标题', description: 'OG 描述' });
  });

  it('没有 og 时退到 <title> 与 meta[name=description]', () => {
    const html =
      '<head><title> 网页标题 </title><meta name="description" content="普通描述"></head>';
    expect(extractMeta(html)).toEqual({ title: '网页标题', description: '普通描述' });
  });

  it('属性顺序任意：content 在前也能认出', () => {
    const html = '<meta content="倒序标题" property="og:title">';
    expect(extractMeta(html).title).toBe('倒序标题');
  });

  it('单双引号都支持', () => {
    expect(extractMeta("<meta property='og:title' content='单引号'>").title).toBe('单引号');
    expect(extractMeta('<meta property="og:title" content="双引号">').title).toBe('双引号');
  });

  it('标签与属性名大小写不敏感', () => {
    const html = '<META PROPERTY="og:title" CONTENT="大写标签">';
    expect(extractMeta(html).title).toBe('大写标签');
  });

  it('解码常见具名实体', () => {
    const html =
      '<meta property="og:title" content="a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &apos;f&apos;">';
    expect(extractMeta(html).title).toBe('a & b <c> "d" \'e\' \'f\'');
  });

  it('解码 &nbsp;（随后按折叠规则变成普通空格，不是字面量）', () => {
    expect(extractMeta('<title>a&nbsp;b</title>').title).toBe('a b');
    expect(extractMeta('<title>a&nbsp;&nbsp;b</title>').title).toBe('a b');
  });

  it('解码十进制与十六进制数字实体', () => {
    expect(extractMeta('<title>&#8217;</title>').title).toBe('\u2019');
    expect(extractMeta('<title>&#x2019;</title>').title).toBe('\u2019');
    expect(extractMeta('<title>&#X2014;</title>').title).toBe('\u2014');
  });

  it('未知实体原样保留', () => {
    expect(extractMeta('<title>&unknownthing;</title>').title).toBe('&unknownthing;');
  });

  it('trim 并折叠连续空白', () => {
    expect(extractMeta('<title>  a\n   b  </title>').title).toBe('a b');
  });

  it('截断到 300 字符', () => {
    const long = 'x'.repeat(500);
    expect(extractMeta('<title>' + long + '</title>').title).toBe('x'.repeat(300));
    expect(extractMeta('<title>' + long + '</title>').title.length).toBe(300);
  });

  it('什么都没有时返回两个空串', () => {
    expect(extractMeta('<html><body>没有 meta</body></html>')).toEqual({ title: '', description: '' });
  });

  it('空字符串返回两个空串且不抛', () => {
    expect(() => extractMeta('')).not.toThrow();
    expect(extractMeta('')).toEqual({ title: '', description: '' });
  });

  it('content 为空的 meta 被忽略', () => {
    expect(extractMeta('<meta property="og:title" content="">').title).toBe('');
  });

  it('1MB 无 meta 的 HTML 在 200ms 内完成', () => {
    let html = '';
    while (html.length < 1024 * 1024) {
      html += '<div class="row"><span>一些正文</span><a href="/x">链接</a></div>';
    }
    const started = Date.now();
    const meta = extractMeta(html);
    const elapsed = Date.now() - started;
    expect(meta).toEqual({ title: '', description: '' });
    expect(elapsed).toBeLessThan(200);
  });

  it('1MB 且带 meta 的 HTML 也在 200ms 内完成', () => {
    let body = '';
    while (body.length < 1024 * 1024) {
      body += '<div class="row"><span>一些正文</span><a href="/x">链接</a></div>';
    }
    const html =
      '<head><title>大页面</title><meta property="og:title" content="大页面 OG">' +
      '<meta name="description" content="大页面描述"></head><body>' +
      body +
      '</body>';
    const started = Date.now();
    const meta = extractMeta(html);
    const elapsed = Date.now() - started;
    expect(meta).toEqual({ title: '大页面 OG', description: '大页面描述' });
    expect(elapsed).toBeLessThan(200);
  });
});

describe('shouldFetchUrl', () => {
  it('普通公网链接放行', () => {
    expect(shouldFetchUrl('https://example.com/a')).toBe(true);
    expect(shouldFetchUrl('http://example.com/a?b=1')).toBe(true);
    expect(shouldFetchUrl('example.com/a')).toBe(true);
    expect(shouldFetchUrl('https://sub.example.co.uk:8443/a')).toBe(true);
  });

  it('拒绝本机地址', () => {
    expect(shouldFetchUrl('http://localhost/')).toBe(false);
    expect(shouldFetchUrl('http://localhost:3000/a')).toBe(false);
    expect(shouldFetchUrl('http://127.0.0.1/')).toBe(false);
    expect(shouldFetchUrl('http://127.0.0.1:8080/')).toBe(false);
    expect(shouldFetchUrl('http://127.1.2.3/')).toBe(false);
    expect(shouldFetchUrl('http://0.0.0.0/')).toBe(false);
    expect(shouldFetchUrl('http://[::1]/')).toBe(false);
    expect(shouldFetchUrl('http://[::1]:8080/')).toBe(false);
  });

  it('拒绝 .local 结尾', () => {
    expect(shouldFetchUrl('http://printer.local/')).toBe(false);
    expect(shouldFetchUrl('https://a.b.local/x')).toBe(false);
  });

  it('拒绝内网 IPv4', () => {
    expect(shouldFetchUrl('http://10.0.0.1/')).toBe(false);
    expect(shouldFetchUrl('http://10.255.255.254/x')).toBe(false);
    expect(shouldFetchUrl('http://192.168.1.1/')).toBe(false);
    expect(shouldFetchUrl('http://172.16.0.1/')).toBe(false);
    expect(shouldFetchUrl('http://172.31.255.254/')).toBe(false);
  });

  it('172.16-31 之外的同段地址不算内网', () => {
    expect(shouldFetchUrl('http://172.15.0.1/')).toBe(true);
    expect(shouldFetchUrl('http://172.32.0.1/')).toBe(true);
  });

  it('拒绝纯 IPv6 字面量', () => {
    expect(shouldFetchUrl('http://[2001:db8::1]/')).toBe(false);
    expect(shouldFetchUrl('https://[fe80::1]:443/a')).toBe(false);
  });

  it('拒绝不含点的主机名', () => {
    expect(shouldFetchUrl('http://intranet/')).toBe(false);
    expect(shouldFetchUrl('http://intranet:8080/a')).toBe(false);
  });

  it('拒绝非 http(s) 协议', () => {
    expect(shouldFetchUrl('ftp://example.com/a')).toBe(false);
    expect(shouldFetchUrl('mailto:a@b.com')).toBe(false);
    expect(shouldFetchUrl('file:///c:/a.txt')).toBe(false);
    expect(shouldFetchUrl('data:text/html,<b>x</b>')).toBe(false);
  });

  it('拒绝超过 2048 字符', () => {
    expect(shouldFetchUrl('https://example.com/' + 'x'.repeat(2048))).toBe(false);
    expect(shouldFetchUrl('https://example.com/' + 'x'.repeat(2000))).toBe(true);
  });

  it('拒绝空串与纯空白', () => {
    expect(shouldFetchUrl('')).toBe(false);
    expect(shouldFetchUrl('   ')).toBe(false);
  });

  it('拒绝含空格的非 URL 文本', () => {
    expect(shouldFetchUrl('https://example.com/a b')).toBe(false);
    expect(shouldFetchUrl('这是一段中文正文，不是链接')).toBe(false);
  });
});
