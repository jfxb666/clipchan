import { afterEach, describe, expect, it } from 'vitest';
import { getPlatform, setPlatform } from './adapter';
import type { PlatformAdapter } from '../types';

afterEach(() => setPlatform(null));

describe('getPlatform', () => {
  it('没有注入时返回桩，方法 reject 且带中文说明', async () => {
    const p = getPlatform();
    await expect(p.items.list({})).rejects.toThrow(/当前环境没有实现/);
    expect(p.capabilities.autoPaste).toBe(false);
  });

  it('订阅类方法返回可调用的取消函数（不抛）', () => {
    const off = getPlatform().items.onChanged(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('注入后返回注入对象本身', () => {
    const fake = { items: { list: async () => [] } } as unknown as PlatformAdapter;
    setPlatform(fake);
    expect(getPlatform()).toBe(fake);
  });

  it('setPlatform(null) 恢复探测', () => {
    const fake = {} as PlatformAdapter;
    setPlatform(fake);
    setPlatform(null);
    expect(getPlatform()).not.toBe(fake);
  });
});
