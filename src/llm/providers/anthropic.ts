// Anthropic Claude Messages API
// 文档：https://docs.claude.com/en/api/messages
// 与 OpenAI 不同点：
//   - 鉴权 header 是 `x-api-key`，需要 `anthropic-version`
//   - 消息格式：system 字段独立，messages 里只有 user/assistant
//   - 流式事件是命名 SSE（message_start / content_block_delta / message_stop 等）

import type { ChatDelta, ChatRequest, Provider, ProviderRuntimeConfig } from '../types';
import { iterateSse } from '../sse';
import { fetchWithRetry } from '../retry';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicProvider: Provider = {
  meta: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Claude Messages API。注意：浏览器/扩展直连需依赖 `anthropic-dangerous-direct-browser-access` header。',
    defaultBaseUrl: DEFAULT_BASE_URL,
    suggestedModels: [
      { id: 'claude-sonnet-4-5', hint: '综合推荐' },
      { id: 'claude-opus-4-1', hint: '最强推理，成本高' },
      { id: 'claude-3-5-haiku-latest', hint: '快速/低成本' },
    ],
    defaultModel: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  chat(config: ProviderRuntimeConfig, req: ChatRequest) {
    return anthropicChat(config, req);
  },
};

async function* anthropicChat(
  config: ProviderRuntimeConfig,
  req: ChatRequest,
): AsyncIterable<ChatDelta> {
  if (!config.apiKey) {
    yield { done: true, error: '未配置 Anthropic API Key' };
    return;
  }

  const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  // system 字段独立，合并所有 system 角色的消息
  const systemParts = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content);
  const chatMessages = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
    messages: chatMessages,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (typeof req.temperature === 'number') body.temperature = req.temperature;

  let resp: Response;
  try {
    resp = await fetchWithRetry(`${base}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
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
    const text = await resp.text().catch(() => '');
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
      const data = evt.data?.trim();
      if (!data) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      // content_block_delta：正文增量
      if (evt.event === 'content_block_delta' || parsed?.type === 'content_block_delta') {
        const delta = parsed?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { content: delta.text };
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { reasoning: delta.thinking };
        }
      } else if (evt.event === 'message_stop' || parsed?.type === 'message_stop') {
        yield { done: true };
        return;
      } else if (parsed?.type === 'error') {
        yield { done: true, error: parsed?.error?.message ?? 'Anthropic API 返回错误' };
        return;
      }
    }
    yield { done: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { done: true, error: `流式读取失败：${msg}` };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
