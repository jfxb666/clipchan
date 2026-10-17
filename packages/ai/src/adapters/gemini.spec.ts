import { afterEach, describe, expect, it } from 'vitest';
import { adapterFor } from './index';
import { startFakeServer, type FakeServer } from './fake-server';
import type { ProviderConfig } from '../types';

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  if (!server) throw new Error('server 未启动');
  return {
    id: 'p3',
    name: 'Gemini',
    protocol: 'gemini',
    baseUrl: server.url,
    model: 'gemini-2.0-flash',
    ...overrides,
  };
}

describe('gemini adapter', () => {
  it('chat 正常，key 走 ?key= 查询参数', async () => {
    server = await startFakeServer({
      '/v1beta/models/gemini-2.0-flash:generateContent': () => ({
        status: 200,
        body: { candidates: [{ content: { parts: [{ text: '优化后的提示词' }] } }] },
      }),
    });

    const text = await adapterFor('gemini').chat(
      cfg(),
      'gm-test-key',
      [
        { role: 'system', content: '你是提示词优化器' },
        { role: 'user', content: '帮我写个提示词' },
      ],
      { timeoutMs: 5000 },
    );

    expect(text).toBe('优化后的提示词');
    const req = server.requests[0];
    expect(req?.path).toContain('key=gm-test-key');
    const body = JSON.parse(req?.body ?? '{}') as {
      systemInstruction?: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
    };
    expect(body.systemInstruction?.parts[0]?.text).toBe('你是提示词优化器');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '帮我写个提示词' }] }]);
  });

  it('listModels 剥掉 models/ 前缀', async () => {
    server = await startFakeServer({
      '/v1beta/models': () => ({
        status: 200,
        body: { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }] },
      }),
    });

    await expect(adapterFor('gemini').listModels(cfg(), 'gm-test-key')).resolves.toEqual([
      'gemini-2.0-flash',
      'gemini-1.5-pro',
    ]);
    expect(server.requests[0]?.path).toContain('/v1beta/models');
    expect(server.requests[0]?.path).toContain('key=gm-test-key');
  });

  it('401 抛 AiError(auth)', async () => {
    server = await startFakeServer({
      '/v1beta/models/gemini-2.0-flash:generateContent': () => ({
        status: 401,
        body: { error: { message: 'API key not valid' } },
      }),
    });

    await expect(
      adapterFor('gemini').chat(cfg(), 'gm-bad', [{ role: 'user', content: 'hi' }], { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('超时抛 AiError(timeout)：timeoutMs 50 + delayMs 200', async () => {
    server = await startFakeServer({
      '/v1beta/models/gemini-2.0-flash:generateContent': () => ({
        status: 200,
        body: { candidates: [{ content: { parts: [{ text: '太慢了' }] } }] },
        delayMs: 200,
      }),
    });

    await expect(
      adapterFor('gemini').chat(cfg(), 'gm-test-key', [{ role: 'user', content: 'hi' }], { timeoutMs: 50 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
