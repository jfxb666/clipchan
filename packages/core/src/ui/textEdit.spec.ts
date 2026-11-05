import { describe, expect, it } from 'vitest';
import { editTextActions } from './textEdit';

describe('条目编辑再粘贴（v1.2 A2）', () => {
  it('★ 空内容不可粘贴/不可存片段（disabled 判定）', () => {
    expect(editTextActions('   ').canPaste).toBe(false);
    expect(editTextActions('abc').canPaste).toBe(true);
  });
  it('编辑内容与原内容相同也算可粘贴（用户可能就是要重粘一遍）', () => {
    expect(editTextActions('same').canPaste).toBe(true);
  });
});
