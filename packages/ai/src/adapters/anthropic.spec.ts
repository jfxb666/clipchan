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
    id: 'p2',
    name: 'Claude 官方',
    protocol: 'anthropic',
    baseUrl: server.url,
    model: 'claude-3-5-sonnet',
    ...overrides,
  };
}

describe('anthropic adapter', () => {
  it('chat 正常，带 x-api-key 与 anthropic-version，system 提到顶层', async () => {
    server = await startFakeServer({
      '/v1/messages': () => ({ status: 200, body: { content: [{ type: 'text', text: '好的' }] } }),
    });

    const text = await adapterFor('anthropic').chat(
      cfg(),
      'ak-test-key',
      [
        { role: 'system', content: '你是提示词优化器' },
        { role: 'user', content: '帮我写个提示词' },
      ],
      { timeoutMs: 5000 },
    );

    expect(text).toBe('好的');
    const req = server.requests[0];
    expect(req?.headers['x-api-key']).toBe('ak-test-key');
    expect(req?.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(req?.body ?? '{}') as {
      system?: string;
      max_tokens?: number;
      messages: { role: string; content: string }[];
    };
    expect(body.system).toBe('你是提示词优化器');
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: 'user', content: '帮我写个提示词' }]);
  });

  it('listModels 打到 /v1/models', async () => {
    server = await startFakeServer({
      '/v1/models': () => ({ status: 200, body: { data: [{ id: 'claude-3-5-sonnet' }, { id: 'claude-3-haiku' }] } }),
    });

    await expect(adapterFor('anthropic').listModels(cfg(), 'ak-test-key')).resolves.toEqual([
      'claude-3-5-sonnet',
      'claude-3-haiku',
    ]);
    expect(server.requests[0]?.path).toBe('/v1/models');
    expect(server.requests[0]?.headers['x-api-key']).toBe('ak-test-key');
  });

  it('401 抛 AiError(auth)', async () => {
    server = await startFakeServer({
      '/v1/messages': () => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }),
    });

    await expect(
      adapterFor('anthropic').chat(cfg(), 'ak-bad', [{ role: 'user', content: 'hi' }], { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('超时抛 AiError(timeout)：timeoutMs 50 + delayMs 200', async () => {
    server = await startFakeServer({
      '/v1/messages': () => ({ status: 200, body: { content: [{ text: '太慢了' }] }, delayMs: 200 }),
    });

    await expect(
      adapterFor('anthropic').chat(cfg(), 'ak-test-key', [{ role: 'user', content: 'hi' }], { timeoutMs: 50 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
