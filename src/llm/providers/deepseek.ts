// DeepSeek
// 文档：https://api-docs.deepseek.com/zh-cn/
// 注意：deepseek-reasoner 会额外返回 reasoning_content（思考过程），PaperLens 对公式推导任务会优先选它

import type { ChatRequest, Provider, ProviderRuntimeConfig } from '../types';
import { openaiCompatibleChat } from './openaiCompatible';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

export const deepseekProvider: Provider = {
  meta: {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方 API，OpenAI 兼容模式。数学推导任务推荐 deepseek-reasoner。',
    defaultBaseUrl: DEFAULT_BASE_URL,
    suggestedModels: [
      { id: 'deepseek-chat', hint: '日常对话、摘要' },
      { id: 'deepseek-reasoner', hint: 'R1 推理模型，数学推导首选' },
    ],
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  chat(config: ProviderRuntimeConfig, req: ChatRequest) {
    const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    return openaiCompatibleChat(config, req, {
      endpoint: `${base}/chat/completions`,
    });
  },
};
