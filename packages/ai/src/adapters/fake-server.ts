import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 测试用假服务：只按 pathname 精确匹配路由，未知路径回 404。 */
export interface FakeRequest {
  method: string;
  /** 请求目标原样（含 query），便于断言 ?key= 之类的参数。 */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeResponse {
  status: number;
  body: unknown;
  /** 延后 end() 的毫秒数，用于超时用例。 */
  delayMs?: number;
  /** 响应头立刻发、响应体延后这么久才 end：模拟"200 已到、体还在流"的中途超时。 */
  bodyDelayMs?: number;
}

export type FakeRoutes = Record<string, (req: FakeRequest) => FakeResponse>;

export interface FakeServer {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) body += chunk as string;
  return body;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  routes: FakeRoutes,
  requests: FakeRequest[],
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://127.0.0.1');
  const entry: FakeRequest = {
    method: req.method ?? 'GET',
    path: rawUrl,
    headers: req.headers,
    body: await readBody(req),
  };
  requests.push(entry);

  const route = routes[url.pathname];
  const result: FakeResponse = route ? route(entry) : { status: 404, body: { error: 'not found' } };

  const send = (): void => {
    try {
      res.writeHead(result.status, { 'content-type': 'application/json' });
      if (result.bodyDelayMs && result.bodyDelayMs > 0) {
        // 头已发出、体故意拖着：专测"超时发生在读体阶段"的错误定性。
        setTimeout(() => {
          try {
            res.end(JSON.stringify(result.body));
          } catch {
            // 客户端已因超时断开，忽略写入失败
          }
        }, result.bodyDelayMs);
      } else {
        res.end(JSON.stringify(result.body));
      }
    } catch {
      // 客户端已因超时断开，忽略写入失败
    }
  };
  if (result.delayMs && result.delayMs > 0) setTimeout(send, result.delayMs);
  else send();
}

export async function startFakeServer(routes: FakeRoutes): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    void handle(req, res, routes, requests);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake server 未拿到端口');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close(): Promise<void> {
      // keep-alive 连接会拖住 close()，先断空闲/剩余连接再等回调，避免 vitest 句柄泄漏
      server.closeIdleConnections();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
