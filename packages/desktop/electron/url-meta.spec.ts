/**
 * 链接预览抓取的用例（url-meta.ts 验收）。
 *
 * ★ 全程不发真实网络请求：fetchImpl 从 UrlMetaDeps 注入替身。
 *   本模块最该被盯住的恰恰是**失败路径**（超时、非 2xx、超大响应、内网地址），
 *   这些都只有靠替身才测得出来。
 */
import { describe, expect, it } from 'vitest';
import { createUrlMeta } from './url-meta';
import type { UrlMetaDeps } from './url-meta';

/** 假响应：只实现 createUrlMeta 真正读的三个成员。 */
interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get(name: string): string | null };
}

function resp(html: string, ok = true, status = 200): FakeResponse {
  return { ok, status, text: () => Promise.resolve(html) };
}

/** 记下每次被请求的地址；behavior 决定返回什么。 */
function spyFetch(behavior: (url: string) => Promise<FakeResponse>) {
  const calls: string[] = [];
  const fn = (url: string): Promise<FakeResponse> => {
    calls.push(url);
    return behavior(url);
  };
  return { fn, calls };
}

/** 造一个只换了 fetchImpl 的 deps，其余保持默认。 */
function depsOf(fetchImpl: UrlMetaDeps['fetchImpl'], extra: Partial<UrlMetaDeps> = {}): UrlMetaDeps {
  return { fetchImpl, ...extra };
}

const HTML_WITH_TITLE =
  '<html><head><meta property="og:title" content="示例标题"><title>标签标题</title></head><body>x</body></html>';

describe('createUrlMeta.fetchPreview 正常路径', () => {
  it('抓取成功时返回 url/title/domain/iconUrl/fetchedAt 五个字段', async () => {
    const spy = spyFetch(() => Promise.resolve(resp(HTML_WITH_TITLE)));
    const api = createUrlMeta(depsOf(spy.fn, { now: () => 1_700_000_000_000 }));

    const pv = await api.fetchPreview('https://www.example.com/a/b?x=1');
    expect(pv).not.toBeNull();
    // og:title 优先于 <title>（规则在 core 的 extractMeta 里）
    expect(pv?.title).toBe('示例标题');
    // domain 去掉 www. 前缀
    expect(pv?.domain).toBe('example.com');
    // ★ 图标只用链接自身主机，绝不含第三方
    expect(pv?.iconUrl).toBe('https://www.example.com/favicon.ico');
    expect(pv?.fetchedAt).toBe(1_700_000_000_000);
    // url 是归一化后的字符串（缓存主键）
    expect(pv?.url).toBe('https://www.example.com/a/b?x=1');
  });

  it('标题缺失时用域名兜底，绝不返回空标题', async () => {
    const spy = spyFetch(() => Promise.resolve(resp('<html><head></head><body>无标题</body></html>')));
    const api = createUrlMeta(depsOf(spy.fn));

    const pv = await api.fetchPreview('https://blog.example.org/post');
    expect(pv?.title).toBe('blog.example.org');
    expect(pv?.domain).toBe('blog.example.org');
  });

  it('无协议输入会先补 https 再请求', async () => {
    const spy = spyFetch(() => Promise.resolve(resp(HTML_WITH_TITLE)));
    const api = createUrlMeta(depsOf(spy.fn));

    const pv = await api.fetchPreview('example.com/x');
    expect(spy.calls).toEqual(['https://example.com/x']);
    expect(pv?.url).toBe('https://example.com/x');
  });

  it('fetchedAt 用注入的 now，而不是系统时钟', async () => {
    const spy = spyFetch(() => Promise.resolve(resp(HTML_WITH_TITLE)));
    const api = createUrlMeta(depsOf(spy.fn, { now: () => 42 }));

    expect((await api.fetchPreview('https://example.com/'))?.fetchedAt).toBe(42);
  });

  it('两个不同 url 各自独立，互不串味', async () => {
    const spy = spyFetch((url) =>
      Promise.resolve(resp('<title>' + url + '</title>')),
    );
    const api = createUrlMeta(depsOf(spy.fn));

    const a = await api.fetchPreview('https://a.example.com/');
    const b = await api.fetchPreview('https://b.example.com/');
    expect(a?.title).toBe('https://a.example.com/');
    expect(b?.title).toBe('https://b.example.com/');
    expect(a?.url).not.toBe(b?.url);
    expect(spy.calls.length).toBe(2);
  });
});

describe('createUrlMeta.fetchPreview 拒绝路径（不发请求）', () => {
  it('shouldFetchUrl 拒绝的内网地址根本不调用 fetchImpl', async () => {
    const spy = spyFetch(() => Promise.resolve(resp(HTML_WITH_TITLE)));
    const api = createUrlMeta(depsOf(spy.fn));

    const pv = await api.fetchPreview('http://192.168.1.1/admin');
    expect(pv).toBeNull();
    // ★ 关键断言：不是"抓了但丢掉"，而是一个请求都没发出去
    expect(spy.calls.length).toBe(0);
  });

  it('本机地址同样一个请求都不发', async () => {
    const spy = spyFetch(() => Promise.resolve(resp(HTML_WITH_TITLE)));
    const api = createUrlMeta(depsOf(spy.fn));

    expect(await api.fetchPreview('http://localhost:3000/x')).toBeNull();
    expect(await api.fetchPreview('http://127.0.0.1/')).toBeNull();
    expect(spy.calls.length).toBe(0);
  });

  it('非法 URL 返回 null 且不调用 fetchImpl', async () => {
    const spy = spyFetch(() => Promise.resolve(resp(HTML_WITH_TITLE)));
    const api = createUrlMeta(depsOf(spy.fn));

    // 带空格的"URL"多半是误判的正文；javascript: 这种协议一律不认
    expect(await api.fetchPreview('这不是 一个链接')).toBeNull();
    expect(await api.fetchPreview('javascript:alert(1)')).toBeNull();
    expect(await api.fetchPreview('')).toBeNull();
    expect(spy.calls.length).toBe(0);
  });
});

describe('createUrlMeta.fetchPreview 失败路径（永不抛）', () => {
  it('非 2xx 返回 null', async () => {
    const spy = spyFetch(() => Promise.resolve(resp('<title>x</title>', false, 404)));
    const api = createUrlMeta(depsOf(spy.fn));

    expect(await api.fetchPreview('https://example.com/404')).toBeNull();
    expect(spy.calls.length).toBe(1);
  });

  it('响应体超过 maxBytes 返回 null（不截断解析）', async () => {
    const big = '<title>x</title>' + 'a'.repeat(64);
    const spy = spyFetch(() => Promise.resolve(resp(big)));
    const api = createUrlMeta(depsOf(spy.fn, { maxBytes: 16 }));

    expect(await api.fetchPreview('https://example.com/big')).toBeNull();
  });

  it('fetch 永不 resolve 时按超时返回 null，且耗时远小于默认预算', async () => {
    const spy = spyFetch(() => new Promise<FakeResponse>(() => {}));
    const api = createUrlMeta(depsOf(spy.fn, { timeoutMs: 20 }));

    const started = Date.now();
    const pv = await api.fetchPreview('https://example.com/hang');
    const elapsed = Date.now() - started;
    expect(pv).toBeNull();
    // 20ms 的超时预算，2s 是极宽松的上界：只证明"确实超时退出"而不是挂死
    expect(elapsed).toBeLessThan(2000);
  });

  it('读 body 卡住也走同一条超时预算', async () => {
    const spy = spyFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {}),
      }),
    );
    const api = createUrlMeta(depsOf(spy.fn, { timeoutMs: 20 }));

    const started = Date.now();
    expect(await api.fetchPreview('https://example.com/slow-body')).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fetchImpl 抛异常时返回 null，异常不外泄', async () => {
    const spy = spyFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const api = createUrlMeta(depsOf(spy.fn));

    await expect(api.fetchPreview('https://example.com/')).resolves.toBeNull();
  });

  it('超时后 abort 会被发出去（让配合的 fetch 释放 socket）', async () => {
    let aborted = false;
    const api = createUrlMeta({
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise<FakeResponse>(() => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    });

    expect(await api.fetchPreview('https://example.com/abort')).toBeNull();
    expect(aborted).toBe(true);
  });
});
