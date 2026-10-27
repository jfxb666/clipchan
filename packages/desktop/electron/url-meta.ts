/**
 * 链接预览抓取（v1.1.0）。
 *
 * ★ 铁律与 ocr.ts / qrcode.ts 完全一致：顶层**不 import electron、不 import fs**，
 *   网络能力从 `UrlMetaDeps.fetchImpl` 注入 —— 否则 url-meta.spec.ts 在没有 Electron
 *   运行时的环境里根本 import 不进来，而这个模块恰恰是最该被单测盯住的（它要发网络请求）。
 * ★ 任何失败都回 null，永不抛异常：抓预览是**后台附属任务**，用户复制一条链接这件事
 *   绝不该因为对方站点超时/证书错/返回 403 而失败。
 */
import { domainOf, extractMeta, normalizeUrl, shouldFetchUrl } from '@clipchan/core';
import type { UrlPreviewDTO } from '@clipchan/core';

/** 默认超时：6 秒。★ 比浏览器默认的 30s 短得多——预览是锦上添花，用户等不起。 */
const DEFAULT_TIMEOUT_MS = 6000;
/** 默认响应上限 512KB：正常页面的 <head> 远小于此，超了基本不是能预览的东西。 */
const DEFAULT_MAX_BYTES = 512 * 1024;

/** 日志前缀，与 ocr.ts / qrcode.ts / images.ts 的 '[ocr] ' '[qr] ' '[images] ' 保持一致。 */
const WARN = '[url-meta] ';

/**
 * 注入的网络能力（只用到这三个字段，不依赖 fetch 的完整类型）。
 * ★ 故意不 import lib.dom 的 Response：本模块跑在主进程，"能 read text、能看 ok/status"
 *   就够，接口窄一点，测试替身才好写。
 */
export interface UrlMetaDeps {
  fetchImpl: (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    headers?: { get(name: string): string | null };
  }>;
  /** 整体抓取预算（含读 body），默认 6000ms。 */
  timeoutMs?: number;
  /** 响应体长度上限，默认 512KB。 */
  maxBytes?: number;
  /** 时间来源注入（测试断言 fetchedAt 用），缺省 Date.now。 */
  now?: () => number;
}

export interface UrlMetaApi {
  /** 抓一次预览；任何失败都返回 null，永不抛异常（后台任务不该拖垮录制管线） */
  fetchPreview(url: string): Promise<UrlPreviewDTO | null>;
}

/** 失败原因统一成一句可读文本；非 Error 也要有字（绝不回 undefined 假装成功）。 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && e.message !== '') return e.message;
  return String(e);
}

/** 正数校验：非法/缺省一律落到 fallback，绝不让 0 或 NaN 变成"立刻超时"。 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 造预览抓取面。
 * @param deps 依赖注入；main.ts 传 { fetchImpl: (u, init) => fetch(u, init) }。
 */
export function createUrlMeta(deps: UrlMetaDeps): UrlMetaApi {
  const timeoutMs = positiveOr(deps.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveOr(deps.maxBytes, DEFAULT_MAX_BYTES);
  const now = deps.now ?? (() => Date.now());

  return {
    fetchPreview: async (url: string): Promise<UrlPreviewDTO | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      try {
        const normalized = normalizeUrl(String(url ?? ''));
        if (normalized === null) return null;

        // ★ 内网/本机地址一个请求都不发：既是**隐私**（用户复制的 192.168.x.x 管理后台
        //   地址不该被任何程序访问），也是**安全**（本进程不该成为打内网的跳板）。
        //   判定全在字符串上做、不查 DNS，所以这里不会有额外网络往返。
        if (!shouldFetchUrl(normalized)) return null;

        // ★ 超时用 Promise.race 而不是"只 abort 依赖对方配合"：
        //   注入的 fetch 未必理会 signal（真机上 Electron 的 fetch 会，但"永不 resolve"
        //   才是线上最该覆盖的失败形态——DNS 黑洞、对端半开连接都长这样）。
        //   abort 仍然照发，给配合的实现在超时后立刻释放 socket。
        const timedOut = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('抓取超时（' + timeoutMs + 'ms）'));
          }, timeoutMs);
        });

        // ★ 只发 accept：不要 UA / referer 之类会暴露"这是哪个程序"的字段。
        //   User-Agent 由 Electron 的全局 fetch 自己带（Chrome UA），不必也不能伪造成别的。
        const res = await Promise.race([
          deps.fetchImpl(normalized, {
            signal: controller.signal,
            headers: { accept: 'text/html,application/xhtml+xml' },
          }),
          timedOut,
        ]);
        if (!res.ok) return null;

        // ★ body 也进同一条超时预算：大页面读到一半卡住和连不上是一回事。
        const html = await Promise.race([res.text(), timedOut]);
        // ★ 超限**直接放弃**，不截断后再解析：截断的 HTML 会解析出半截 <title（甚至把
        //   内联的 JSON/JS 当正文），显示给用户的是一串乱码——不如什么都不显示。
        //   而 512KB 以上的 HTML 本来也不是"一张能预览的卡片"该有的体积。
        if (html.length > maxBytes) return null;

        const meta = extractMeta(html);

        // ★ 图标只用**链接自身主机**的 /favicon.ico，绝不回落到 faviconCandidates 里的
        //   google s2 第三方服务：那等于把「用户复制了哪些链接」泄露给第三方。
        //   本项目的承诺是零服务器依赖，抓不到图标就不显示图标。
        const parsed = new URL(normalized);
        const host = parsed.hostname.toLowerCase();
        const domain = domainOf(normalized) || host;
        const iconUrl = host.length > 0 ? 'https://' + host + '/favicon.ico' : '';
        // ★ 标题为空时用域名兜底：卡片上写一行空白比写 "example.com" 更让人以为程序坏了。
        const title = meta.title.length > 0 ? meta.title : domain;

        return { url: normalized, title, domain, iconUrl, fetchedAt: now() };
      } catch (e) {
        console.warn(WARN + reasonOf(e));
        return null;
      } finally {
        // ★ finally 里 clearTimeout：成功/失败/超时三条路都必须清掉，否则定时器会一直
        //   挂在事件循环上（每条链接一个），进程退出都被拖慢。
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
