/**
 * IPC 边界错误包装测试。
 *
 * ★ Electron 的 ipcMain.handle 只序列化 Error 实例的 message/name/stack：
 *   处理器 throw 普通对象（如 @clipchan/ai 的 AiError）时，渲染层拿到的
 *   是 "Error invoking remote method 'x': [object Object]"，结构化信息全丢。
 *   所以 registerIpc 在注册处统一把非 Error 抛出物包成 Error（消息保留）。
 */
import { describe, expect, it } from 'vitest';
import { openDb } from './db';
import { runRestore, toIpcError } from './ipc';

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

/**
 * ★ 恢复冲突必须变成**可读结果**而不是异常：T1 的 db.restore 在同内容已占住活跃行时
 *   返回 false（唯一索引挡住 UPDATE）。直接把它当错误抛出去，界面只会看到
 *   "Error invoking remote method 'items:restore'"，用户完全不知道发生了什么。
 */
describe('runRestore：冲突翻成可读结果，不抛异常', () => {
  it('正常恢复 → {ok:true}，行回到活跃列表', () => {
    const db = openDb(':memory:');
    const r = db.insertText('要恢复的内容');
    db.remove(r.id);
    expect(db.list({}).length).toBe(0);

    expect(runRestore(db, r.id)).toEqual({ ok: true });
    expect(db.list({}).some((x) => x.id === r.id)).toBe(true);
    expect(db.listTrash({}).length).toBe(0);
    db.close();
  });

  it('★ 同内容已在活跃列表 → {ok:false, reason:"duplicate"}，且不抛', () => {
    const db = openDb(':memory:');
    const old = db.insertText('重复内容');
    db.remove(old.id); // 进回收站
    // 删掉后用户又复制了同样的东西：活跃行占住了 content_hash
    const fresh = db.insertText('重复内容');
    expect(fresh.id).not.toBe(old.id);

    let result: unknown;
    expect(() => {
      result = runRestore(db, old.id);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'duplicate' });

    // 回收站里那条还在（没被静默吞掉），活跃的还是新那条
    expect(db.listTrash({}).some((x) => x.id === old.id)).toBe(true);
    expect(db.list({}).some((x) => x.id === fresh.id)).toBe(true);
    db.close();
  });

  it('id 不在回收站里 → {ok:false, reason:"missing"}', () => {
    const db = openDb(':memory:');
    expect(runRestore(db, 'no-such-id')).toEqual({ ok: false, reason: 'missing' });

    // 活跃行（不在回收站）也按 missing 处理：恢复只对回收站行有意义
    const active = db.insertText('活跃内容');
    expect(runRestore(db, active.id)).toEqual({ ok: false, reason: 'missing' });
    db.close();
  });
});
