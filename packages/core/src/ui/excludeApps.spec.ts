import { describe, expect, it } from 'vitest';
import {
  EXCLUDE_APPS_MAX,
  addExcludeApp,
  excludeAppsHint,
  normalizeAppEntry,
  removeExcludeApp,
  suggestExcludeApps,
} from './excludeApps';

describe('normalizeAppEntry', () => {
  it('完整 Windows 路径取文件名并小写', () => {
    expect(normalizeAppEntry('C:\\Program Files\\1Password\\1Password.exe')).toBe('1password.exe');
  });

  it('带引号的路径（资源管理器「复制为路径」）', () => {
    expect(normalizeAppEntry('"C:\\Apps\\KeePass.exe"')).toBe('keepass.exe');
  });

  it('POSIX 风格的路径也认', () => {
    expect(normalizeAppEntry('/usr/local/bin/Bitwarden.EXE')).toBe('bitwarden.exe');
  });

  it('只有文件名时原样（转小写）', () => {
    expect(normalizeAppEntry('  LastPass.EXE  ')).toBe('lastpass.exe');
  });

  it('空串 / 纯空白 / 只有引号 -> 空串', () => {
    expect(normalizeAppEntry('')).toBe('');
    expect(normalizeAppEntry('   ')).toBe('');
    expect(normalizeAppEntry('""')).toBe('');
  });
});

describe('addExcludeApp', () => {
  it('新增（归一化后入库）', () => {
    expect(addExcludeApp([], 'C:\\X\\Enpass.exe')).toEqual(['enpass.exe']);
  });

  it('重复（含大小写与路径差异）不新增', () => {
    expect(addExcludeApp(['keepass.exe'], 'C:\\Bin\\KeePass.exe')).toEqual(['keepass.exe']);
  });

  it('空输入不新增', () => {
    expect(addExcludeApp(['a.exe'], '   ')).toEqual(['a.exe']);
  });

  it('超过上限不新增', () => {
    const full = Array.from({ length: EXCLUDE_APPS_MAX }, (_, i) => 'app' + i + '.exe');
    expect(addExcludeApp(full, 'new.exe')).toHaveLength(EXCLUDE_APPS_MAX);
    expect(addExcludeApp(full, 'new.exe')).toEqual(full);
  });

  it('总是返回新数组（React 靠引用变化重渲染）', () => {
    const list = ['a.exe'];
    expect(addExcludeApp(list, 'a.exe')).not.toBe(list);
    expect(addExcludeApp(list, 'b.exe')).not.toBe(list);
  });

  it('不改原数组', () => {
    const list = ['a.exe'];
    addExcludeApp(list, 'b.exe');
    expect(list).toEqual(['a.exe']);
  });
});

describe('removeExcludeApp', () => {
  it('移除指定项', () => {
    expect(removeExcludeApp(['a.exe', 'b.exe'], 'a.exe')).toEqual(['b.exe']);
  });

  it('不存在时原样', () => {
    expect(removeExcludeApp(['a.exe'], 'zz.exe')).toEqual(['a.exe']);
  });

  it('返回新数组', () => {
    const list = ['a.exe'];
    expect(removeExcludeApp(list, 'zz.exe')).not.toBe(list);
  });
});

describe('excludeAppsHint', () => {
  it('空清单说明能挡什么', () => {
    expect(excludeAppsHint([])).toContain('没有排除任何应用');
  });

  it('非空清单报数', () => {
    expect(excludeAppsHint(['a.exe', 'b.exe'])).toBe('已排除 2 个应用，来自它们的复制不会被记录。');
  });
});

describe('suggestExcludeApps', () => {
  it('非空', () => {
    expect(suggestExcludeApps().length).toBeGreaterThan(0);
  });

  it('全小写（与 normalizeAppEntry 的结果同口径，否则一键添加会塞进重复项）', () => {
    for (const name of suggestExcludeApps()) expect(name).toBe(name.toLowerCase());
  });
});
