// Background 端：消费 LLM Port，调度 Provider 流式返回数据
// 由 entrypoints/background.ts 在初始化时安装

import { getProvider } from './providers';
import { loadSettings, resolveTaskBinding } from '../storage/settings';
import type { LlmClientMessage, LlmServerMessage } from './protocol';
import { LLM_PORT_NAME } from './protocol';

/** 为一个 Port 跑一次完整的对话 */
export function installLlmPortHandler(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== LLM_PORT_NAME) return;

    const abortController = new AbortController();
    let started = false;

    const send = (msg: LlmServerMessage) => {
      try {
        port.postMessage(msg);
      } catch {
        // port 已关闭，忽略
      }
    };

    port.onDisconnect.addListener(() => {
      abortController.abort();
    });

    port.onMessage.addListener(async (raw: LlmClientMessage) => {
      if (!raw || typeof raw !== 'object') return;

      if (raw.type === 'abort') {
        abortController.abort();
        return;
      }

      if (raw.type !== 'start') return;
      if (started) {
        send({ type: 'error', message: '该连接已有进行中的会话，请新开一个 Port' });
        return;
      }
      started = true;

      try {
        const settings = await loadSettings();
        const resolved = resolveTaskBinding(settings, raw.task);

        const providerId = raw.overrides?.providerId ?? resolved.providerId;
        const baseConfig =
          raw.overrides?.providerId && raw.overrides.providerId !== resolved.providerId
            ? settings.providers[raw.overrides.providerId]
            : resolved.config;
        // 允许临时 overrides（用于 Options 页测试连接）
        const providerConfig = {
          apiKey: raw.overrides?.apiKey ?? baseConfig?.apiKey ?? '',
          baseUrl: raw.overrides?.baseUrl ?? baseConfig?.baseUrl,
          defaultModel: baseConfig?.defaultModel,
        };
        const model = raw.overrides?.model ?? resolved.model;

        if (!providerConfig.apiKey) {
          send({
            type: 'error',
            message: `Provider ${providerId} 尚未配置 API Key，请打开扩展设置页填写`,
          });
          send({ type: 'done' });
          return;
        }

        send({ type: 'ready', providerId, model });

        const provider = getProvider(providerId);
        const iter = provider.chat(providerConfig, {
          model,
          messages: raw.messages,
          temperature: raw.overrides?.temperature,
          maxTokens: raw.overrides?.maxTokens,
          signal: abortController.signal,
        });

        for await (const delta of iter) {
          if (abortController.signal.aborted) return;
          if (delta.error) {
            send({ type: 'error', message: delta.error });
          } else if (delta.content || delta.reasoning) {
            send({ type: 'delta', content: delta.content, reasoning: delta.reasoning });
          }
          if (delta.done) {
            send({ type: 'done' });
            return;
          }
        }
        send({ type: 'done' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message });
        send({ type: 'done' });
      }
    });
  });
}
