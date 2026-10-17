import { describe, expect, it } from 'vitest';
import { classify } from './classify';

describe('classify', () => {
  it('识别链接（含大小写与 www/ftp）', () => {
    expect(classify('https://example.com/a')).toBe('link');
    expect(classify('HTTP://EXAMPLE.COM')).toBe('link');
    expect(classify('www.bilibili.com')).toBe('link');
    expect(classify('ftp://files.local/x')).toBe('link');
  });

  it('识别 Windows 路径与 UNC 路径', () => {
    expect(classify('C:\\Users\\Administrator\\Desktop')).toBe('path');
    expect(classify('D:/tmp/x.txt')).toBe('path');
    expect(classify('\\\\server\\share\\file.txt')).toBe('path');
  });

  it('识别纯数字（含千分位/百分比/正负号）', () => {
    expect(classify('12345')).toBe('number');
    expect(classify('-12.5%')).toBe('number');
    expect(classify('1,234.56')).toBe('number');
    expect(classify('123456789012345678901234567890')).toBe('text');
  });

  it('识别代码：关键字命中', () => {
    expect(classify('function foo() {}')).toBe('code');
    expect(classify('const a = 1;')).toBe('code');
    expect(classify('SELECT * FROM t')).toBe('code');
  });

  it('识别代码：符号密度达到 12%', () => {
    expect(classify('a{b}c;d(e)=f<g>h')).toBe('code');
  });

  it('多行文本不按链接/路径/数字归类，落到代码或文本', () => {
    expect(classify('https://a.com\nhttps://b.com')).toBe('text');
    expect(classify('hello\nworld')).toBe('text');
  });

  it('普通中文文本仍是文本', () => {
    expect(classify('今天下午三点开会')).toBe('text');
    expect(classify('剪贴板酱')).toBe('text');
  });
});
