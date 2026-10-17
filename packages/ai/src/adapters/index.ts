import type { AiProtocol, ProviderAdapter } from '../types';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';
import { openaiCompatAdapter } from './openai-compat';

/** 协议 → 适配器。未知协议显式抛错，不静默返回 undefined。 */
export function adapterFor(protocol: AiProtocol): ProviderAdapter {
  switch (protocol) {
    case 'openai-compat':
      return openaiCompatAdapter;
    case 'anthropic':
      return anthropicAdapter;
    case 'gemini':
      return geminiAdapter;
    default: {
      const never: never = protocol;
      throw new Error(`unknown protocol: ${String(never)}`);
    }
  }
}

export { anthropicAdapter, geminiAdapter, openaiCompatAdapter };
