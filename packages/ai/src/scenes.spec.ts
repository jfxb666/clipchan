import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SCENES, sceneById, type Scene } from './scenes';

/** 计划 Task 3 Step 1「四个内置场景齐全」：按 id 排序后的期望值。 */
const EXPECTED_IDS = ['ai-generation', 'casual', 'general', 'product'];

/** 用查表方式定位场景，避免测试依赖数组顺序。 */
function byId(id: string): Scene | undefined {
  return BUILTIN_SCENES.find((s) => s.id === id);
}

function rulesOf(id: string): string {
  return (byId(id)?.rules ?? []).join('\n');
}

describe('scenes · 内置场景数据', () => {
  it('四个内置场景齐全，id 与计划一致', () => {
    expect([...BUILTIN_SCENES.map((s) => s.id)].sort()).toEqual(EXPECTED_IDS);
  });

  it('每条场景规则够用（>= 4 条）且覆盖该场景的方法论要点', () => {
    for (const scene of BUILTIN_SCENES) {
      expect(scene.rules.length, `场景 ${scene.id} 规则不足 4 条`).toBeGreaterThanOrEqual(4);
    }
    // general：明确角色与目标 / 补足上下文 / 指定输出格式与长度 / 显式分步推理 / 给出成功判据
    expect(rulesOf('general')).toMatch(/角色/);
    expect(rulesOf('general')).toMatch(/上下文/);
    expect(rulesOf('general')).toMatch(/格式/);
    expect(rulesOf('general')).toMatch(/分步/);
    expect(rulesOf('general')).toMatch(/成功判据/);
    // ai-generation：主体+场景+风格+构图+光线+画质 / 负面提示词单列 / 参数化可复用 / 避免冲突风格词
    expect(rulesOf('ai-generation')).toMatch(/风格/);
    expect(rulesOf('ai-generation')).toMatch(/构图/);
    expect(rulesOf('ai-generation')).toMatch(/光线/);
    expect(rulesOf('ai-generation')).toMatch(/画质/);
    expect(rulesOf('ai-generation')).toMatch(/负面提示词/);
    expect(rulesOf('ai-generation')).toMatch(/参数/);
    expect(rulesOf('ai-generation')).toMatch(/冲突/);
    // product：一句话价值主张 / 目标用户与痛点 / 差异化与证据 / 结构化分段 / 可验证事实
    expect(rulesOf('product')).toMatch(/价值主张/);
    expect(rulesOf('product')).toMatch(/目标用户/);
    expect(rulesOf('product')).toMatch(/痛点/);
    expect(rulesOf('product')).toMatch(/差异化/);
    expect(rulesOf('product')).toMatch(/可验证/);
    // casual：语气与关系匹配 / 长度贴合渠道 / 保留本人口吻 / 给 1 个直接可发的版本
    expect(rulesOf('casual')).toMatch(/语气/);
    expect(rulesOf('casual')).toMatch(/渠道/);
    expect(rulesOf('casual')).toMatch(/口吻/);
    expect(rulesOf('casual')).toMatch(/直接可发/);
  });

  it('id 唯一', () => {
    const ids = BUILTIN_SCENES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('name / description 非空，且 description 长度 >= 10', () => {
    for (const scene of BUILTIN_SCENES) {
      expect(scene.name.trim().length, `场景 ${scene.id} 缺 name`).toBeGreaterThan(0);
      expect(scene.description.trim().length, `场景 ${scene.id} description 太短`).toBeGreaterThanOrEqual(10);
    }
  });

  it('每条场景都有可展示的 example（input / output 非空）', () => {
    for (const scene of BUILTIN_SCENES) {
      expect(scene.example, `场景 ${scene.id} 缺 example`).toBeDefined();
      expect((scene.example?.input ?? '').trim().length, `场景 ${scene.id} example.input 为空`).toBeGreaterThan(0);
      expect((scene.example?.output ?? '').trim().length, `场景 ${scene.id} example.output 为空`).toBeGreaterThan(0);
    }
  });

  it('sceneById 查得到内置场景', () => {
    expect(sceneById('general')?.id).toBe('general');
    expect(sceneById('casual')?.name).toBe('日常交流');
  });

  it('sceneById 查不到时返回 undefined（调用方回落 general）', () => {
    expect(sceneById('nope')).toBeUndefined();
  });

  it('sceneById 能查到自定义场景', () => {
    const custom: Scene[] = [
      { id: 'x', name: '自定义场景', description: '用户自己定义的场景', rules: ['按我的要求来'] },
    ];
    expect(sceneById('x', custom)).toBe(custom[0]);
  });
});

describe('scenes · 离线约束', () => {
  it('scenes.ts 是纯数据模块：源码不含 fetch( 与 http', () => {
    const source = readFileSync(new URL('./scenes.ts', import.meta.url), 'utf8');
    expect(source.length).toBeGreaterThan(0);
    expect(source.includes('fetch(')).toBe(false);
    expect(source.toLowerCase().includes('http')).toBe(false);
  });
});
