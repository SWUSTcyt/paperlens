// OpenAI Chat Completions 兼容模式的公共实现
// OpenAI / DeepSeek / Qwen(DashScope compatible-mode) 都符合此协议

import type { ChatDelta, ChatRequest, ProviderRuntimeConfig } from '../types';
import { iterateSse } from '../sse';
import { fetchWithRetry } from '../retry';

export interface OpenAICompatibleOptions {
  /** 完整的 chat completions URL（例如 https://api.openai.com/v1/chat/completions） */
  endpoint: string;
  /** 鉴权 header 名称，默认 "Authorization"，值为 `Bearer <key>` */
  authHeaderName?: string;
  /** 额外 header */
  extraHeaders?: Record<string, string>;
}

/**
 * 发起 OpenAI 兼容的流式 chat 请求。
 * - 自动组装 `{ model, messages, stream: true }`
 * - 解析 SSE，返回 ChatDelta
 * - 支持 DeepSeek 的 `reasoning_content` 字段
 */
export async function* openaiCompatibleChat(
  config: ProviderRuntimeConfig,
  req: ChatRequest,
  opts: OpenAICompatibleOptions,
): AsyncIterable<ChatDelta> {
  if (!config.apiKey) {
    yield { done: true, error: '未配置 API Key，请到扩展的设置页填写后重试' };
    return;
  }

  const authHeader = opts.authHeaderName ?? 'Authorization';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [authHeader]: `Bearer ${config.apiKey}`,
    ...(opts.extraHeaders ?? {}),
  };

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
  };
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;

  let resp: Response;
  try {
    resp = await fetchWithRetry(opts.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (err) {
    if ((err as any)?.name === 'AbortError') return;
    const msg = err instanceof Error ? err.message : String(err);
    yield { done: true, error: `网络请求失败：${msg}` };
    return;
  }

  if (!resp.ok) {
    const text = await safeReadText(resp);
    yield {
      done: true,
      error: `HTTP ${resp.status} ${resp.statusText}${text ? `：${truncate(text, 400)}` : ''}`,
    };
    return;
  }
  if (!resp.body) {
    yield { done: true, error: '响应无 body，流式读取失败' };
    return;
  }

  try {
    for await (const evt of iterateSse(resp.body)) {
      const data = evt.data.trim();
      if (!data || data === '[DONE]') {
        if (data === '[DONE]') {
          yield { done: true };
          return;
        }
        continue;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed?.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? choice.message;
      const content: string | undefined = delta?.content;
      const reasoning: string | undefined =
        delta?.reasoning_content ?? delta?.reasoning ?? undefined;
      if (content || reasoning) {
        yield { content, reasoning };
      }
      if (choice.finish_reason) {
        yield { done: true };
        return;
      }
    }
    yield { done: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { done: true, error: `流式读取失败：${msg}` };
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
