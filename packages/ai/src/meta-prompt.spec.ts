import { describe, expect, it } from 'vitest';
import { buildMetaPrompt, type TargetMode } from './meta-prompt';
import type { Scene } from './scenes';

const SCENE: Scene = {
  id: 'general',
  name: '通用对话',
  description: '对 AI 提需求、问问题，把随手写的诉求补成一条能直接用的提示词',
  rules: ['明确角色与目标', '补足上下文', '指定输出格式与长度', '给出成功判据'],
  example: { input: '帮我看看这个方案行不行', output: '你是有十年经验的产品负责人……' },
};

/** 用户原文（很长，任何一处完整复述都会被断言抓到）。 */
const TEXT = '帮我看看这个方案行不行，下周要给老板汇报，我担心预算和排期这两块说不清楚。';

function build(mode: TargetMode, extra?: string) {
  return buildMetaPrompt({ text: TEXT, scene: SCENE, mode, ...(extra === undefined ? {} : { extra }) });
}

function userContent(mode: TargetMode, extra?: string): string {
  const messages = build(mode, extra);
  const user = messages.find((m) => m.role === 'user');
  return user?.content ?? '';
}

function joined(mode: TargetMode, extra?: string): string {
  return build(mode, extra)
    .map((m) => m.content)
    .join('\n');
}

describe('buildMetaPrompt', () => {
  it('结构：返回 2 条消息，第一条 role 为 system，两条 content 均非空', () => {
    for (const mode of ['user', 'system'] as const) {
      const messages = build(mode);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('system');
      expect(messages[1]?.role).toBe('user');
      expect(messages[0]?.content.trim().length).toBeGreaterThan(0);
      expect(messages[1]?.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('两种模式模板实际不同：user 与 system 的 user content 不相等（Review Focus 5）', () => {
    const userMode = userContent('user');
    const systemMode = userContent('system');
    expect(userMode).not.toBe(systemMode);
    expect(userMode.trim().length).toBeGreaterThan(0);
    expect(systemMode.trim().length).toBeGreaterThan(0);
  });

  it('system 模式语义：含「角色」「边界」，且不复述 input.text 原文（Review Focus 5）', () => {
    const content = userContent('system');
    expect(content).toContain('角色');
    expect(content).toContain('边界');
    expect(content).not.toContain(TEXT);
    // 用户模式的模板反过来必须携带原文，否则优化器看不到素材
    expect(userContent('user')).toContain(TEXT);
  });

  it('规则注入：两种模式的 user content 里逐条出现 scene.rules 的每一条', () => {
    for (const mode of ['user', 'system'] as const) {
      const content = userContent(mode);
      for (const rule of SCENE.rules) {
        expect(content, `mode=${mode} 缺少规则：${rule}`).toContain(rule);
      }
    }
  });

  it('extra 透传：传了 extra 就出现在 prompt 里；不传时全文不含 undefined', () => {
    const extra = '输出请用简体中文，并保留我提到的时间点。';
    expect(joined('user', extra)).toContain(extra);
    expect(joined('system', extra)).toContain(extra);
    expect(joined('user')).not.toContain('undefined');
    expect(joined('system')).not.toContain('undefined');
  });

  it('格式契约：两种模式都要求输出 <optimized> 与 <notes> 两个标签', () => {
    for (const mode of ['user', 'system'] as const) {
      const content = userContent(mode);
      expect(content).toContain('<optimized>');
      expect(content).toContain('<notes>');
      expect(joined(mode)).toContain('<optimized>');
      expect(joined(mode)).toContain('<notes>');
    }
  });
});
