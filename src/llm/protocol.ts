// SidePanel <-> Background 之间跑 LLM 流式对话的消息协议
// 使用 chrome.runtime.connect 建立长连接（Port）：
//   - SidePanel 发 {type:'start', task, messages, overrides?} 开启
//   - SidePanel 发 {type:'abort'} 取消
//   - Background 回 {type:'delta', ...} / {type:'done'} / {type:'error', ...}
//   - Port 关闭 => background 自动 abort

import type { ChatMessage, ProviderId } from './types';

export const LLM_PORT_NAME = 'paperlens.llm';

export type TaskKind = 'summary' | 'derivation' | 'default';

/** 客户端 (SidePanel) -> Background */
export type LlmClientMessage =
  | {
      type: 'start';
      task: TaskKind;
      messages: ChatMessage[];
      /** 可覆盖设置里的绑定（例如用户临时切换模型） */
      overrides?: {
        providerId?: ProviderId;
        model?: string;
        temperature?: number;
        maxTokens?: number;
        /** 覆盖 apiKey：主要用于 Options 页的"测试连接"（用户尚未保存时） */
        apiKey?: string;
        /** 覆盖 baseUrl */
        baseUrl?: string;
      };
    }
  | { type: 'abort' };

/** Background -> 客户端 (SidePanel) */
export type LlmServerMessage =
  | { type: 'ready'; providerId: ProviderId; model: string }
  | { type: 'delta'; content?: string; reasoning?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
