/**
 * 按来源分组的纯逻辑单测（不渲染 SourceGroupList.tsx：仓库没有 jsdom）。
 */
import { describe, expect, it } from 'vitest';
import type { ClipItemDTO } from '../types';
import { UNKNOWN_SOURCE_LABEL, groupBySource, sourceLabel } from './sourceGroups';

function dto(patch: Partial<ClipItemDTO> & { id: string }): ClipItemDTO {
  return { kind: 'text', preview: '', createdAt: 0, pinned: false, source: 'capture', ...patch };
}

describe('sourceLabel', () => {
  it('去掉尾部 .exe（大小写不敏感），其余原样保留', () => {
    expect(sourceLabel('Code.exe')).toBe('Code');
    expect(sourceLabel('code.EXE')).toBe('code');
    expect(sourceLabel('wezterm-gui')).toBe('wezterm-gui');
    // 只去尾部一层：中间的同名片段属于文件名本身，不能动。
    expect(sourceLabel('Code.exe.bak')).toBe('Code.exe.bak');
  });

  it('undefined / 空白 / 只剩后缀都算未知来源', () => {
    expect(sourceLabel(undefined)).toBe(UNKNOWN_SOURCE_LABEL);
    expect(sourceLabel('   ')).toBe(UNKNOWN_SOURCE_LABEL);
    expect(sourceLabel('.exe')).toBe(UNKNOWN_SOURCE_LABEL);
  });
});

describe('groupBySource', () => {
  it('组按组内最新 createdAt 倒序，未知来源固定垫底', () => {
    const items = [
      dto({ id: 'a1', sourceApp: 'Code.exe', createdAt: 100 }),
      dto({ id: 'b1', sourceApp: 'chrome.exe', createdAt: 300 }),
      dto({ id: 'a2', sourceApp: 'Code.exe', createdAt: 200 }),
      // 未知来源这条最新，但它必须排在最后 —— 它不是「最活跃的来源」。
      dto({ id: 'u1', createdAt: 900 }),
    ];

    const groups = groupBySource(items);

    expect(groups.map((group) => group.label)).toEqual(['chrome', 'Code', UNKNOWN_SOURCE_LABEL]);
    expect(groups.map((group) => group.key)).toEqual(['chrome', 'Code', UNKNOWN_SOURCE_LABEL]);
    // 组内保持传入顺序（列表已由 SQL 排好，分组不再二次排序）。
    expect(groups[1]!.items.map((item) => item.id)).toEqual(['a1', 'a2']);
  });
});
