import { buildMetaPrompt, type TargetMode } from './meta-prompt';
import type { Scene } from './scenes';
import type { ChatMessage, ProviderAdapter, ProviderConfig } from './types';

/** 优化请求的默认超时上限（Review Focus 3：默认 60s，超时给中文提示，面板不假死）。 */
export const DEFAULT_TIMEOUT_MS = 60000;

/** 模型未按格式输出时写入 notes 的那条提示（Review Focus 4）。 */
export const DEGRADED_NOTE = '模型未按格式输出，已直接采用全文';

export interface OptimizeInput {
  text: string;
  scene: Scene;
  mode: TargetMode;
  extra?: string;
  /** 调用方（主进程）可传入 AbortSignal；本轮不做取消通道，只透传。 */
  signal?: AbortSignal;
  /** 覆盖默认超时（测试用）。 */
  timeoutMs?: number;
}

export interface OptimizeResult {
  optimized: string;
  notes: string[];
  degraded: boolean;
}

/** 剥掉 markdown 代码块围栏；不是围栏包裹则原样返回。 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^\`\`\`[^\n]*\n([\s\S]*?)\n?\`\`\`$/.exec(trimmed);
  return fenced?.[1] !== undefined ? fenced[1].trim() : trimmed;
}

/**
 * 解析模型输出（Task 4 Step 3）：
 * 1. 含 <optimized> 标签 → 按标签切分（<notes> 缺失时 notes = []）。
 * 2. 否则整体被代码块包裹 → 剥壳，degraded 仍为 false。
 * 3. 否则整段当成品，degraded = true 并附一条说明（Review Focus 4）。
 */
export function parseOptimized(raw: string): OptimizeResult {
  const optimizedMatch = /<optimized>([\s\S]*?)<\/optimized>/.exec(raw);
  if (optimizedMatch?.[1] !== undefined) {
    const notesMatch = /<notes>([\s\S]*?)<\/notes>/.exec(raw);
    const notes = (notesMatch?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { optimized: optimizedMatch[1].trim(), notes, degraded: false };
  }

  const stripped = stripFence(raw);
  const isFenced = stripped !== raw.trim();
  if (isFenced) {
    return { optimized: stripped, notes: [], degraded: false };
  }

  return { optimized: stripped, notes: [DEGRADED_NOTE], degraded: true };
}

/**
 * 优化编排（Task 4 Step 4）：buildMetaPrompt → adapter.chat → parseOptimized。
 * adapter.chat 的异常不吞，原样上抛，由主进程统一 toAiError 结构化。
 */
export async function optimize(
  adapter: ProviderAdapter,
  cfg: ProviderConfig,
  key: string,
  input: OptimizeInput,
): Promise<OptimizeResult> {
  const messages: ChatMessage[] = buildMetaPrompt({
    text: input.text,
    scene: input.scene,
    mode: input.mode,
    ...(input.extra === undefined ? {} : { extra: input.extra }),
  });

  const raw = await adapter.chat(cfg, key, messages, {
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return parseOptimized(raw);
}
