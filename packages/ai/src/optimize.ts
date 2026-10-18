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
  /** 流式预览：每收到一段增量就把「已可展示的成品」回调一次。 */
  onPreview?: (preview: string) => void;
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
 * 从流式累积的原文里提取「当前可展示的成品」，供面板边下边显示。
 * 1. 已有 <optimized> 开标签：取其后内容（闭标签未到就取到末尾）。
 * 2. 否则若被代码块围栏包住：剥壳。
 * 3. 否则原样（未 trim 掉内部换行）。
 */
export function previewOf(accumulated: string): string {
  const open = accumulated.indexOf('<optimized>');
  if (open !== -1) {
    const body = accumulated.slice(open + '<optimized>'.length);
    const close = body.indexOf('</optimized>');
    return (close === -1 ? body : body.slice(0, close)).trim();
  }
  return stripFence(accumulated);
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

  const opts = {
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  // 流式优先：慢模型（实测 23–60s+）靠增量把「首字节」提前，整段超时不再是瓶颈。
  const raw = adapter.chatStream
    ? await adapter.chatStream(cfg, key, messages, {
        ...opts,
        ...(input.onPreview === undefined
          ? {}
          : {
              onDelta: (() => {
                let acc = '';
                return (delta: string): void => {
                  acc += delta;
                  input.onPreview?.(previewOf(acc));
                };
              })(),
            }),
      })
    : await adapter.chat(cfg, key, messages, opts);

  return parseOptimized(raw);
}
