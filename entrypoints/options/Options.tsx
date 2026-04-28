import { useEffect, useMemo, useState } from 'react';
import { listProviderMeta } from '../../src/llm/providers';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type ProviderConfig,
  type Settings,
  type TaskModelBinding,
} from '../../src/storage/settings';
import { chatOnce } from '../../src/bridge/llmBridge';
import type { ProviderId } from '../../src/llm/types';

/**
 * PaperLens 设置页
 * - 配置四家 Provider 的 API Key / Base URL / 默认模型
 * - 选择"默认 Provider"
 * - 选择"按任务分配模型"（摘要 vs 公式推导）
 * - 对每个 Provider 提供"测试连接"按钮
 */
export default function Options() {
  const providers = useMemo(() => listProviderMeta(), []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings).catch((err) => {
      console.error(err);
      setSettings(defaultSettings());
    });
  }, []);

  if (!settings) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-slate-500">
        正在加载设置…
      </div>
    );
  }

  function update(mut: (draft: Settings) => void) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next: Settings = JSON.parse(JSON.stringify(prev));
      mut(next);
      return next;
    });
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setMessage(null);
    try {
      await saveSettings(settings);
      setMessage({ kind: 'ok', text: '已保存。所有改动立即生效，无需重启扩展。' });
    } catch (err) {
      setMessage({
        kind: 'err',
        text: '保存失败：' + (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">PaperLens 设置</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          配置你的 LLM Provider。API Key 仅存储于浏览器本地 (<code>chrome.storage.local</code>)，不做任何云端同步。
        </p>
      </header>

      {message && (
        <div
          className={
            'mb-4 rounded-md border p-3 text-sm ' +
            (message.kind === 'ok'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
              : 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200')
          }
        >
          {message.text}
        </div>
      )}

      <section className="mb-6 space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">默认 Provider</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          当没有为具体任务单独绑定时，所有请求走该 Provider。
        </p>
        <div className="flex flex-wrap gap-2">
          {providers.map((p) => (
            <label
              key={p.id}
              className={
                'cursor-pointer rounded-md border px-3 py-1.5 text-sm transition ' +
                (settings.defaultProviderId === p.id
                  ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200'
                  : 'border-slate-200 hover:border-brand-400 dark:border-slate-700')
              }
            >
              <input
                type="radio"
                name="defaultProviderId"
                value={p.id}
                className="mr-2"
                checked={settings.defaultProviderId === p.id}
                onChange={() =>
                  update((s) => {
                    s.defaultProviderId = p.id;
                  })
                }
              />
              {p.label}
            </label>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">按任务分配模型（可选）</h2>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          没有特殊需求可以留空。常见做法：摘要用 qwen-plus / 推导用 deepseek-reasoner。
        </p>
        <TaskBindingEditor
          title="论文解读任务"
          binding={settings.summaryModel}
          onChange={(b) => update((s) => { s.summaryModel = b; })}
        />
        <TaskBindingEditor
          title="公式推导任务"
          binding={settings.derivationModel}
          onChange={(b) => update((s) => { s.derivationModel = b; })}
        />
      </section>

      <h2 className="mb-3 text-base font-semibold text-slate-800 dark:text-slate-100">Provider 配置</h2>
      <div className="space-y-4">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            meta={p}
            config={settings.providers[p.id]}
            onChange={(c) => update((s) => { s.providers[p.id] = c; })}
          />
        ))}
      </div>

      <div className="sticky bottom-0 mt-6 flex justify-end gap-2 bg-slate-50/80 py-3 backdrop-blur dark:bg-slate-950/80">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </div>
  );
}

function TaskBindingEditor({
  title,
  binding,
  onChange,
}: {
  title: string;
  binding: TaskModelBinding | undefined;
  onChange: (b: TaskModelBinding | undefined) => void;
}) {
  const providers = listProviderMeta();
  const [enabled, setEnabled] = useState(!!binding);

  useEffect(() => {
    setEnabled(!!binding);
  }, [binding]);

  const currentProvider = binding?.providerId ?? 'qwen';
  const meta = providers.find((p) => p.id === currentProvider) ?? providers[0];

  return (
    <div className="mb-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <div className="mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const on = e.target.checked;
            setEnabled(on);
            if (!on) {
              onChange(undefined);
            } else {
              onChange({
                providerId: meta.id,
                model: binding?.model || meta.defaultModel,
              });
            }
          }}
        />
        <span className="text-sm font-medium">{title}</span>
      </div>
      {enabled && binding && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            value={binding.providerId}
            onChange={(e) => {
              const nextId = e.target.value as ProviderId;
              const nextMeta = providers.find((p) => p.id === nextId)!;
              onChange({ providerId: nextId, model: nextMeta.defaultModel });
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            className="w-64 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            placeholder="模型名（如 qwen-plus）"
            value={binding.model}
            onChange={(e) => onChange({ ...binding, model: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  meta,
  config,
  onChange,
}: {
  meta: ReturnType<typeof listProviderMeta>[number];
  config: ProviderConfig;
  onChange: (c: ProviderConfig) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      if (!config.apiKey) {
        setTestResult({ ok: false, text: '请先填写 API Key' });
        return;
      }
      // 把当前表单里的 Key/BaseURL 通过 overrides 直接传给 background，
      // 这样用户不用先点"保存"就能测试
      const { content } = await chatOnce({
        task: 'default',
        messages: [
          { role: 'system', content: '只回复两个汉字：可用。' },
          { role: 'user', content: '测试连接' },
        ],
        overrides: {
          providerId: meta.id,
          model: config.defaultModel || meta.defaultModel,
          maxTokens: 32,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
        },
      });
      setTestResult({
        ok: true,
        text: `连接成功：${content.trim().slice(0, 80) || '(空响应)'}`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  const keyFilled = !!config.apiKey;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {meta.label}
            {keyFilled && (
              <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-normal text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200">
                已配置
              </span>
            )}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{meta.description}</p>
        </div>
        <a
          href={meta.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-brand-600 hover:underline dark:text-brand-300"
        >
          获取 API Key →
        </a>
      </div>

      <div className="space-y-2">
        <Field label="API Key">
          <input
            type="password"
            className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
            placeholder={`粘贴 ${meta.label} 的 API Key`}
            value={config.apiKey}
            onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
          />
        </Field>
        <Field label="Base URL（可选）">
          <input
            className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
            placeholder={meta.defaultBaseUrl}
            value={config.baseUrl ?? ''}
            onChange={(e) =>
              onChange({ ...config, baseUrl: e.target.value.trim() || undefined })
            }
          />
        </Field>
        <Field label="默认模型（可选）">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
              placeholder={meta.defaultModel}
              value={config.defaultModel ?? ''}
              list={`models-${meta.id}`}
              onChange={(e) =>
                onChange({ ...config, defaultModel: e.target.value.trim() || undefined })
              }
            />
            <datalist id={`models-${meta.id}`}>
              {meta.suggestedModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.hint ?? ''}
                </option>
              ))}
            </datalist>
            <button
              onClick={handleTest}
              disabled={testing}
              className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-60 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            推荐：
            {meta.suggestedModels.map((m) => (
              <code key={m.id} className="mx-1 rounded bg-slate-100 px-1 dark:bg-slate-800">
                {m.id}
              </code>
            ))}
          </p>
        </Field>
        {testResult && (
          <p
            className={
              'rounded p-2 text-xs ' +
              (testResult.ok
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200')
            }
          >
            {testResult.text}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
      {children}
    </label>
  );
}
