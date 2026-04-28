// Provider 注册表
// 新增 Provider 只需要在此处加入一行即可

import type { Provider, ProviderId, ProviderMeta } from '../types';
import { qwenProvider } from './qwen';
import { deepseekProvider } from './deepseek';
import { openaiProvider } from './openai';
import { anthropicProvider } from './anthropic';

export const PROVIDERS: Record<ProviderId, Provider> = {
  qwen: qwenProvider,
  deepseek: deepseekProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/** 按 UI 建议的展示顺序 */
export const PROVIDER_ORDER: ProviderId[] = ['qwen', 'deepseek', 'openai', 'anthropic'];

export function getProvider(id: ProviderId): Provider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`未知的 LLM Provider：${id}`);
  return p;
}

export function listProviderMeta(): ProviderMeta[] {
  return PROVIDER_ORDER.map((id) => PROVIDERS[id].meta);
}
