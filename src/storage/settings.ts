// chrome.storage.local 封装：LLM Provider 配置持久化
// Key 仅存于 local，不做云同步，也不暴露给 content script

import type { ProviderId } from '../llm/types';
import { PROVIDER_ORDER, getProvider } from '../llm/providers';

/** 单个 Provider 的用户配置 */
export interface ProviderConfig {
  apiKey: string;
  /** 允许覆盖默认 Base URL，例如走代理或 Azure */
  baseUrl?: string;
  /** 该 Provider 下用户选择的默认模型（若没选则用 provider.meta.defaultModel） */
  defaultModel?: string;
}

/** 按任务拆分的模型绑定（高级） */
export interface TaskModelBinding {
  providerId: ProviderId;
  model: string;
}

/** 整体设置 */
export interface Settings {
  /** 默认使用的 Provider（未配置任务级绑定时都走它） */
  defaultProviderId: ProviderId;
  /** 各 Provider 的配置 */
  providers: Record<ProviderId, ProviderConfig>;
  /** 摘要任务的专属模型（可选） */
  summaryModel?: TaskModelBinding;
  /** 公式推导任务的专属模型（可选） */
  derivationModel?: TaskModelBinding;
  /** UI 语言偏好（一期不用，保留位） */
  locale?: 'zh-CN' | 'en';
  /** 摘要详细程度：concise=简洁 / detailed=详细 */
  summaryVerbosity?: 'concise' | 'detailed';
}

const SETTINGS_KEY = 'paperlens.settings';

export function defaultSettings(): Settings {
  const providers = PROVIDER_ORDER.reduce<Record<ProviderId, ProviderConfig>>(
    (acc, id) => {
      acc[id] = { apiKey: '' };
      return acc;
    },
    {} as Record<ProviderId, ProviderConfig>,
  );
  return {
    defaultProviderId: 'qwen',
    providers,
    locale: 'zh-CN',
    summaryVerbosity: 'concise',
  };
}

/** 读取设置；若不存在返回默认值 */
export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = raw?.[SETTINGS_KEY] as Partial<Settings> | undefined;
  return mergeSettings(defaultSettings(), stored);
}

/** 覆盖式写入（调用方负责传完整对象或先 loadSettings 合并） */
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/** 订阅设置变化（Options 页改完立即生效） */
export function onSettingsChanged(callback: (next: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    const next = mergeSettings(
      defaultSettings(),
      changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined,
    );
    callback(next);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * 根据任务类型选出 {providerId, model, providerConfig}：
 * - 优先用任务级绑定
 * - 否则回退到 defaultProviderId + 该 Provider 下的 defaultModel
 */
export interface ResolvedBinding {
  providerId: ProviderId;
  model: string;
  config: ProviderConfig;
}

export function resolveTaskBinding(
  settings: Settings,
  task: 'summary' | 'derivation' | 'default',
): ResolvedBinding {
  const taskBinding =
    task === 'summary'
      ? settings.summaryModel
      : task === 'derivation'
        ? settings.derivationModel
        : undefined;

  if (taskBinding) {
    return {
      providerId: taskBinding.providerId,
      model: taskBinding.model,
      config: settings.providers[taskBinding.providerId] ?? { apiKey: '' },
    };
  }

  const id = settings.defaultProviderId;
  const pConfig = settings.providers[id] ?? { apiKey: '' };
  const fallbackModel = pConfig.defaultModel || getProvider(id).meta.defaultModel;
  return { providerId: id, model: fallbackModel, config: pConfig };
}

function mergeSettings(base: Settings, patch?: Partial<Settings>): Settings {
  if (!patch) return base;
  const providers = { ...base.providers };
  if (patch.providers) {
    for (const id of PROVIDER_ORDER) {
      providers[id] = { ...base.providers[id], ...(patch.providers[id] ?? {}) };
    }
  }
  return {
    ...base,
    ...patch,
    providers,
  };
}
