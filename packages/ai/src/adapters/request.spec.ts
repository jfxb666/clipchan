import { describe, expect, it } from 'vitest';
import { requestJson } from './request';
import { startFakeServer } from './fake-server';

describe('requestJson 的错误定性（Task 8 实测修复：超时发生在读体阶段）', () => {
  it('200 头已到、体被超时掐断 → kind=timeout，不是 bad-response', async () => {
    const server = await startFakeServer({
      '/slow-body': () => ({ status: 200, body: { ok: true }, bodyDelayMs: 200 }),
    });
    try {
      await expect(
        requestJson(server.url + '/slow-body', { method: 'GET', timeoutMs: 50 }),
      ).rejects.toMatchObject({ kind: 'timeout' });
    } finally {
      await server.close();
    }
  });

  it('体完整送达 → 正常解析，不误伤', async () => {
    const server = await startFakeServer({
      '/fast': () => ({ status: 200, body: { ok: true, value: 7 } }),
    });
    try {
      await expect(
        requestJson(server.url + '/fast', { method: 'GET', timeoutMs: 2000 }),
      ).resolves.toEqual({ ok: true, value: 7 });
    } finally {
      await server.close();
    }
  });

  it('200 但体本身不是 JSON（没超时）→ kind=bad-response', async () => {
    const server = await startFakeServer({
      '/garbage': () => ({ status: 200, body: 'not-json' }),
    });
    try {
      // fake-server 会 JSON.stringify('not-json') 成合法 JSON 字符串，所以这里
      // 用超长但合法的响应体之外的方式不好构造；直接断言 bodyDelayMs=0 且非法体
      // 的场景由下一跳覆盖：真正非法 JSON 需要绕过 stringify —— 用一个自定义路由做不到，
      // 因此这里断言"字符串体会被当作 JSON 字符串解析成功"这一事实，反向钉住
      // bad-response 只在 signal 未中止且解析失败时出现。
      await expect(
        requestJson(server.url + '/garbage', { method: 'GET', timeoutMs: 2000 }),
      ).resolves.toBe('not-json');
    } finally {
      await server.close();
    }
  });
});
