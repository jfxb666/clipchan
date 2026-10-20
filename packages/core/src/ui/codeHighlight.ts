import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import type { Kind } from '../types';
import { classify } from '../logic/classify';

/** 超过该字数不渲染高亮，避免长文本拖慢列表。 */
export const HIGHLIGHT_MAX_CHARS = 8000;

/**
 * 卡片里能高亮的语言（13 种，够覆盖剪贴板常见代码）。
 * ★ 只静态注册这 13 种：highlight.js 全量包 190 种语言会显著拖大 renderer bundle，
 *   而 highlightAuto 又要靠全量语言包才准（铁律三禁止）。
 * ★ xml 同时承担 html / xml / svg。
 */
export const HLJS_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'java',
  'csharp',
  'cpp',
  'go',
  'rust',
  'json',
  'xml',
  'css',
  'bash',
  'sql',
] as const;

const REGISTERED: Record<(typeof HLJS_LANGUAGES)[number], typeof javascript> = {
  javascript,
  typescript,
  python,
  java,
  csharp,
  cpp,
  go,
  rust,
  json,
  xml,
  css,
  bash,
  sql,
};

for (const name of HLJS_LANGUAGES) {
  hljs.registerLanguage(name, REGISTERED[name]);
}

/**
 * 纯函数：按文本特征猜语言；猜不出返回 null。
 * ★ 不变量：返回值只能是 HLJS_LANGUAGES 里的成员或 null —— 否则 highlightToHtml 会踩未知语言。
 * ★ 刻意不用 hljs.highlightAuto：那需要全量语言包，且猜错的代价（渲染成乱色）比不猜更高。
 */
export function guessLanguage(text: string): string | null {
  const t = text.trim();
  if (!t) return null;

  if (t.startsWith('#!') && t.includes('bin/')) return 'bash';
  if (t.includes('<?xml') || t.toLowerCase().includes('<html')) return 'xml';
  const pythonDef = /^\s*(?:async\s+)?def\s+\w+\s*\(/m.test(t);
  const pythonImport = /^\s*(?:from|import)\s+\w+/m.test(t) && /:\s*$/m.test(t);
  if (pythonDef || pythonImport) return 'python';
  if (t.includes('fn ') && (t.includes('let mut ') || t.includes('impl ') || t.includes('-> '))) return 'rust';
  if (t.includes('package ') && t.includes('func ')) return 'go';
  if (t.includes('using System')) return 'csharp';
  if (t.includes('#include')) return 'cpp';
  if (t.includes('public ') || t.includes('private ') || t.includes('void ')) return 'java';
  if (t.includes('interface ') || t.includes('type ') || (t.includes('const ') && t.includes('=>'))) {
    return 'typescript';
  }
  if (/\bselect\b[\s\S]*\bfrom\b/i.test(t)) return 'sql';
  // CSS：必须有「属性: 值;」这样的声明，光有 { : ; 会把 JS 对象字面量误判成 CSS。
  if (t.includes('{') && /[-a-z]+\s*:\s*[^;{}]+;/i.test(t)) return 'css';

  return classify(t) === 'code' ? 'javascript' : null;
}

/**
 * 纯函数：是否该对该条渲染语法高亮。
 *
 * ★ 铁律二：有搜索词时只做搜索词高亮。highlightSegments 已经按 term 切 <mark>，
 *   再叠一层 hljs 的 HTML 会嵌套转义错乱，所以搜索态下直接让位。
 */
export function shouldHighlight(kind: Kind, text: string, term: string): boolean {
  if (kind !== 'code') return false;
  if (term.trim() !== '') return false;
  if (text.length > HIGHLIGHT_MAX_CHARS) return false;
  return true;
}

/** 转义 HTML 特殊字符，供未知语言回落时用（hljs 内部已自带同样处理）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 同步：返回 hljs 转义后的 HTML；调用前必须先 shouldHighlight 为 true。
 * ★ 铁律三：只返回 hljs 的 .value（内部已转义），绝不自己拼原文 innerHTML。
 * ★ 未知语言不静默失败：回落成转义后的纯文本，宁可无色也不能吐出未转义内容。
 */
export function highlightToHtml(text: string, language: string): string {
  try {
    return hljs.highlight(text, { language }).value;
  } catch {
    return escapeHtml(text);
  }
}
