import type { AiError, AiProtocol, AiProviderInput } from '../types';

/**
 * 「AI 模型」表单的纯函数与常量（计划 Task 6）：校验、默认地址、错误文案。
 * 组件只负责交互，这里的东西全部可被 node 环境的单测直接调用（无 jsdom）。
 */

/** 三个协议的内置默认地址（计划 Interfaces 指定）。 */
export const DEFAULT_BASE_URL: Record<AiProtocol, string> = {
  'openai-compat': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

/** 协议下拉与徽标的中文文案，组件与设置页共用一份。 */
export const PROTOCOL_OPTIONS: { value: AiProtocol; label: string }[] = [
  { value: 'openai-compat', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
];

/** 协议的中文名；脏值原样返回，避免徽标显示成空白。 */
export function protocolLabel(protocol: string): string {
  return PROTOCOL_OPTIONS.find((option) => option.value === protocol)?.label ?? protocol;
}

const PROTOCOLS: string[] = PROTOCOL_OPTIONS.map((option) => option.value);

/**
 * 校验表单（计划 Step 2 的四条规则）。返回中文错误列表，空数组 = 通过。
 * 只做「能不能发出去」的判断，不碰网络。
 */
export function validateProvider(input: AiProviderInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('请填写名称');
  if (!/^https?:\/\//.test(input.baseUrl.trim())) {
    errors.push('Base URL 必须以 http:// 或 https:// 开头');
  } else if (!isParsableUrl(input.baseUrl.trim())) {
    errors.push('Base URL 不是合法的链接');
  }
  if (!input.model.trim()) errors.push('请填写模型名');
  if (!PROTOCOLS.includes(input.protocol)) errors.push('协议类型不在支持范围内');
  return errors;
}

function isParsableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** kind → 中文；unknown 用原 message（计划 Interfaces 指定）。 */
const KIND_MESSAGES: Record<AiError['kind'], string> = {
  auth: '鉴权失败，请检查 API Key',
  network: '网络连接失败',
  timeout: '请求超时（60 秒）',
  'rate-limit': '请求过于频繁，稍后再试',
  'bad-response': '模型返回格式异常',
  unknown: '',
};

/**
 * 把抛出来的东西变成一句中文提示。结构化错误由 @clipchan/ai 产出，
 * 这里只做 kind 映射，不改 AiError 的形状，也不吞掉未知错误的信息。
 */
export function aiErrorMessage(e: unknown): string {
  const kind = readKind(e);
  const mapped = kind ? KIND_MESSAGES[kind] : '';
  if (mapped) return mapped;
  return readMessage(e) ?? '未知错误';
}

function readKind(e: unknown): AiError['kind'] | null {
  if (typeof e !== 'object' || e === null) return null;
  const kind = (e as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind in KIND_MESSAGES ? (kind as AiError['kind']) : null;
}

function readMessage(e: unknown): string | null {
  if (typeof e === 'string') return e.trim() || null;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return null;
}
