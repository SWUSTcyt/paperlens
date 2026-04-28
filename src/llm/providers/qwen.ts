// Qwen / 通义千问（阿里云 DashScope OpenAI 兼容模式）
// 文档：https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope/

import type { ChatRequest, Provider, ProviderRuntimeConfig } from '../types';
import { openaiCompatibleChat } from './openaiCompatible';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export const qwenProvider: Provider = {
  meta: {
    id: 'qwen',
    label: '通义千问 (Qwen / DashScope)',
    description: '阿里云 DashScope OpenAI 兼容接口。国内访问稳定，推荐用于论文解读等长文任务。',
    defaultBaseUrl: DEFAULT_BASE_URL,
    suggestedModels: [
      { id: 'qwen-max', hint: '综合能力最强' },
      { id: 'qwen-plus', hint: '性价比均衡，推荐默认' },
      { id: 'qwen-turbo', hint: '速度快，长上下文' },
      { id: 'qwen2.5-72b-instruct', hint: '开源模型，参数量大' },
      { id: 'qwen2.5-math-72b-instruct', hint: '数学推导专项' },
    ],
    defaultModel: 'qwen-plus',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
  chat(config: ProviderRuntimeConfig, req: ChatRequest) {
    const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    return openaiCompatibleChat(config, req, {
      endpoint: `${base}/chat/completions`,
    });
  },
};
