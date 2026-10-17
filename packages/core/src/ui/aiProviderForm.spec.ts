import { describe, expect, it } from 'vitest';
import type { AiProtocol } from '../types';
import { DEFAULT_BASE_URL, aiErrorMessage, validateProvider } from './aiProviderForm';

/**
 * 表单校验与错误文案的纯函数测试（无 jsdom，见计划 §2）。
 * 组件本身不写渲染测试，行为都收敛在这里。
 */

describe('validateProvider', () => {
  it('名称为空：返回非空错误列表且提到「名称」', () => {
    const errors = validateProvider({
      name: '',
      protocol: 'openai-compat',
      baseUrl: 'https://x.com/v1',
      model: 'gpt-4o',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('；')).toContain('名称');
  });

  it('baseUrl 缺少协议头：报错且文案提到「http」；三个协议的默认地址都是 https 开头', () => {
    const errors = validateProvider({
      name: 'x',
      protocol: 'openai-compat',
      baseUrl: 'x.com',
      model: 'gpt-4o',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('；')).toContain('http');

    for (const protocol of Object.keys(DEFAULT_BASE_URL) as AiProtocol[]) {
      expect(DEFAULT_BASE_URL[protocol]).toMatch(/^https:\/\//);
    }
  });

  it('模型为空：报错且文案提到「模型」', () => {
    const errors = validateProvider({
      name: 'x',
      protocol: 'openai-compat',
      baseUrl: 'https://x.com/v1',
      model: '',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('；')).toContain('模型');
  });

  it('四项都合法：返回空数组；协议为渲染层脏值时也要拦下', () => {
    expect(
      validateProvider({
        name: 'x',
        protocol: 'openai-compat',
        baseUrl: 'https://x.com/v1',
        model: 'gpt-4o',
      }),
    ).toEqual([]);

    expect(
      validateProvider({
        name: 'x',
        protocol: 'openai' as AiProtocol,
        baseUrl: 'https://x.com/v1',
        model: 'gpt-4o',
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('aiErrorMessage', () => {
  it('auth：提示检查 API Key', () => {
    expect(aiErrorMessage({ kind: 'auth', message: 'whatever' })).toContain('API Key');
  });

  it('timeout：提示超时', () => {
    expect(aiErrorMessage({ kind: 'timeout', message: 'whatever' })).toContain('超时');
  });
});
