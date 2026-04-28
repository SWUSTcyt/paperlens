// OpenAI
// 文档：https://platform.openai.com/docs/api-reference/chat
// 允许覆盖 baseUrl 以便走代理 / Azure OpenAI / 其他 OpenAI 兼容端

import type { ChatRequest, Provider, ProviderRuntimeConfig } from '../types';
import { openaiCompatibleChat } from './openaiCompatible';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export const openaiProvider: Provider = {
  meta: {
    id: 'openai',
    label: 'OpenAI',
    description: '官方 OpenAI API。可在 Base URL 处填写 Azure / 代理地址以走自建端点。',
    defaultBaseUrl: DEFAULT_BASE_URL,
    suggestedModels: [
      { id: 'gpt-4o', hint: '综合能力强' },
      { id: 'gpt-4o-mini', hint: '性价比高' },
      { id: 'gpt-4-turbo', hint: '兼容旧模型名' },
    ],
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  chat(config: ProviderRuntimeConfig, req: ChatRequest) {
    const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    return openaiCompatibleChat(config, req, {
      endpoint: `${base}/chat/completions`,
    });
  },
};
