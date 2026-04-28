// LLM 相关的通用类型
// 所有 Provider 实现都要产出 AsyncIterable<ChatDelta>，上层用 for-await 消费

export type ProviderId = 'qwen' | 'deepseek' | 'openai' | 'anthropic';

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

/** 单次对话的入参 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 用于请求取消 */
  signal?: AbortSignal;
}

/**
 * 流式响应的一个增量块。
 * - content：正文增量
 * - reasoning：DeepSeek R1 / deepseek-reasoner 系列返回的思考过程（可选展示）
 * - done：是否为最后一块（done=true 后不再有新增）
 * - error：出错时的可读消息（由 Provider 包装，避免 SidePanel 直接看到栈）
 */
export interface ChatDelta {
  content?: string;
  reasoning?: string;
  done?: boolean;
  error?: string;
}

/** Provider 运行时配置（从用户 Options 页读取） */
export interface ProviderRuntimeConfig {
  apiKey: string;
  baseUrl?: string;
}

/** Provider 静态元信息（用于 UI 展示、默认值） */
export interface ProviderMeta {
  id: ProviderId;
  label: string;
  description: string;
  defaultBaseUrl: string;
  /** 推荐模型清单（用户仍可自定义输入） */
  suggestedModels: { id: string; hint?: string }[];
  defaultModel: string;
  /** 官方获取 Key 的直达链接 */
  keyUrl: string;
}

/** Provider 实现 */
export interface Provider {
  readonly meta: ProviderMeta;
  /** 发起流式对话 */
  chat(config: ProviderRuntimeConfig, req: ChatRequest): AsyncIterable<ChatDelta>;
}
