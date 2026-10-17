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
    id: 'p1',
    name: '中转站',
    protocol: 'openai-compat',
    baseUrl: server.url,
    model: 'gpt-4o',
    ...overrides,
  };
}

describe('openai-compat adapter', () => {
  it('chat 正常并带上 Authorization: Bearer', async () => {
    server = await startFakeServer({
      '/v1/chat/completions': () => ({
        status: 200,
        body: { choices: [{ message: { content: '优化后的提示词' } }] },
      }),
    });

    const text = await adapterFor('openai-compat').chat(
      cfg(),
      'sk-test-key',
      [{ role: 'user', content: '帮我写个提示词' }],
      { timeoutMs: 5000 },
    );

    expect(text).toBe('优化后的提示词');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer sk-test-key');
    expect(server.requests[0]?.path).toBe('/v1/chat/completions');
  });

  it('listModels 返回模型 id 数组', async () => {
    server = await startFakeServer({
      '/v1/models': () => ({ status: 200, body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] } }),
    });

    await expect(adapterFor('openai-compat').listModels(cfg(), 'sk-test-key')).resolves.toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
    expect(server.requests[0]?.path).toBe('/v1/models');
  });

  it('401 抛 AiError(auth)', async () => {
    server = await startFakeServer({
      '/v1/chat/completions': () => ({ status: 401, body: { error: { message: 'invalid key' } } }),
    });

    await expect(
      adapterFor('openai-compat').chat(cfg(), 'sk-bad', [{ role: 'user', content: 'hi' }], { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('超时抛 AiError(timeout)：timeoutMs 50 + delayMs 200', async () => {
    server = await startFakeServer({
      '/v1/chat/completions': () => ({
        status: 200,
        body: { choices: [{ message: { content: '太慢了' } }] },
        delayMs: 200,
      }),
    });

    await expect(
      adapterFor('openai-compat').chat(cfg(), 'sk-test-key', [{ role: 'user', content: 'hi' }], { timeoutMs: 50 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('/models 返回 {} 时降级为空数组而不抛错', async () => {
    server = await startFakeServer({ '/v1/models': () => ({ status: 200, body: {} }) });

    await expect(adapterFor('openai-compat').listModels(cfg(), 'sk-test-key')).resolves.toEqual([]);
  });
});
