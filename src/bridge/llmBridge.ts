// SidePanel 端的 LLM 客户端：封装 Port 细节，暴露 AsyncIterable 给 UI 用

import { LLM_PORT_NAME, type LlmClientMessage, type LlmServerMessage, type TaskKind } from '../llm/protocol';
import type { ChatMessage, ProviderId } from '../llm/types';

export interface ChatStreamOptions {
  task: TaskKind;
  messages: ChatMessage[];
  overrides?: {
    providerId?: ProviderId;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    apiKey?: string;
    baseUrl?: string;
  };
  /** 可选：外部传入的 AbortSignal，aborted 时会 disconnect port */
  signal?: AbortSignal;
}

export interface ChatStreamChunk {
  /** "delta" | "ready" | "error"；"done" 时迭代自然结束（不会产生 chunk） */
  type: 'ready' | 'delta' | 'error';
  content?: string;
  reasoning?: string;
  providerId?: ProviderId;
  model?: string;
  message?: string;
}

/**
 * 发起一次流式对话，以 AsyncGenerator 方式逐块 yield。
 * 结束（done）时自然返回；任何 error 会作为最后一个 chunk 返回并结束。
 */
export async function* chatStream(opts: ChatStreamOptions): AsyncGenerator<ChatStreamChunk, void, void> {
  const port = chrome.runtime.connect({ name: LLM_PORT_NAME });

  // 用事件队列把 port.onMessage 转成 pull 模型
  const queue: LlmServerMessage[] = [];
  let resolveNext: ((msg: LlmServerMessage | null) => void) | null = null;
  let finished = false;

  const pushMsg = (m: LlmServerMessage | null) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(m);
    } else {
      if (m !== null) queue.push(m);
    }
  };

  port.onMessage.addListener((msg: LlmServerMessage) => pushMsg(msg));
  port.onDisconnect.addListener(() => {
    finished = true;
    pushMsg(null);
  });

  const abortHandler = () => {
    try {
      port.postMessage({ type: 'abort' } satisfies LlmClientMessage);
    } catch {
      // ignore
    }
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const startMsg: LlmClientMessage = {
      type: 'start',
      task: opts.task,
      messages: opts.messages,
      overrides: opts.overrides,
    };
    port.postMessage(startMsg);

    while (!finished) {
      const msg = queue.length > 0 ? queue.shift()! : await new Promise<LlmServerMessage | null>((resolve) => {
        resolveNext = resolve;
      });
      if (!msg) {
        // Port 断开（收到 null）。区分两种情况：
        //   - 用户主动中止：抛 AbortError，让 chatOnce 等上层能感知"未正常完成"，
        //     从而不会把空/残缺内容当成功结果（例如 Map-Reduce 的逐章压缩）。
        //   - 其他原因断开（如服务端结束）：按自然结束处理。
        if (opts.signal?.aborted) {
          throw new DOMException('请求已被用户中止', 'AbortError');
        }
        break;
      }

      if (msg.type === 'ready') {
        yield { type: 'ready', providerId: msg.providerId, model: msg.model };
      } else if (msg.type === 'delta') {
        yield { type: 'delta', content: msg.content, reasoning: msg.reasoning };
      } else if (msg.type === 'error') {
        yield { type: 'error', message: msg.message };
      } else if (msg.type === 'done') {
        return;
      }
    }
  } finally {
    if (opts.signal) {
      opts.signal.removeEventListener('abort', abortHandler);
    }
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  }
}

/** 一次性收集整条响应（非流式场景用） */
export async function chatOnce(
  opts: ChatStreamOptions,
): Promise<{ content: string; reasoning: string; providerId?: ProviderId; model?: string }> {
  let content = '';
  let reasoning = '';
  let providerId: ProviderId | undefined;
  let model: string | undefined;
  for await (const chunk of chatStream(opts)) {
    if (chunk.type === 'ready') {
      providerId = chunk.providerId;
      model = chunk.model;
    } else if (chunk.type === 'delta') {
      if (chunk.content) content += chunk.content;
      if (chunk.reasoning) reasoning += chunk.reasoning;
    } else if (chunk.type === 'error') {
      throw new Error(chunk.message || '未知错误');
    }
  }
  return { content, reasoning, providerId, model };
}
