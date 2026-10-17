/**
 * IPC 边界错误包装测试。
 *
 * ★ Electron 的 ipcMain.handle 只序列化 Error 实例的 message/name/stack：
 *   处理器 throw 普通对象（如 @clipchan/ai 的 AiError）时，渲染层拿到的
 *   是 "Error invoking remote method 'x': [object Object]"，结构化信息全丢。
 *   所以 registerIpc 在注册处统一把非 Error 抛出物包成 Error（消息保留）。
 */
import { describe, expect, it } from 'vitest';
import { toIpcError } from './ipc';

describe('toIpcError', () => {
  it('普通对象（AiError 形状）包成 Error 且保留中文 message', () => {
    const wrapped = toIpcError({ kind: 'timeout', message: '请求超时（60 秒）' });
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('请求超时（60 秒）');
  });

  it('Error 实例原样返回（不改名不改消息）', () => {
    const original = new Error('not-implemented: x');
    expect(toIpcError(original)).toBe(original);
  });

  it('字符串抛出物也包成 Error', () => {
    expect(toIpcError('炸了').message).toBe('炸了');
  });

  it('没有 message 字段的对象：退回 String() 表示，不产生 [object Object]', () => {
    expect(toIpcError({ a: 1 }).message).not.toContain('[object Object]');
  });
});
