import { useRef, useState } from 'react';
import type { PaperContent } from '../../../src/extractors/types';
import { summarizePaper, type SummarizeProgress } from '../../../src/pipelines/summarize';
import { MarkdownView } from '../../../src/components/MarkdownView';

/** 对外暴露的解读结果，供 ExportTab 读取 */
export interface SummaryResult {
  content: string;
  reasoning: string;
  providerId?: string;
  model?: string;
  generatedAt?: number;
}

interface Props {
  paper: PaperContent | null;
  result: SummaryResult | null;
  onResultChange: (r: SummaryResult | null) => void;
}

export function SummaryTab({ paper, result, onResultChange }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SummarizeProgress | null>(null);
  const [verbosity, setVerbosity] = useState<'concise' | 'detailed'>('concise');
  const [showReasoning, setShowReasoning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function handleRun() {
    if (!paper) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setProgress({ phase: 'prepare' });
    let content = '';
    let reasoning = '';
    let providerId: string | undefined;
    let model: string | undefined;

    try {
      for await (const chunk of summarizePaper(paper, {
        verbosity,
        signal: controller.signal,
      })) {
        if (chunk.progress) setProgress(chunk.progress);
        if (chunk.type === 'ready') {
          providerId = chunk.providerId;
          model = chunk.model;
        } else if (chunk.type === 'delta') {
          if (chunk.content) content += chunk.content;
          if (chunk.reasoning) reasoning += chunk.reasoning;
          onResultChange({
            content,
            reasoning,
            providerId,
            model,
            generatedAt: Date.now(),
          });
        } else if (chunk.type === 'error') {
          throw new Error(chunk.message || '未知错误');
        }
      }
      setProgress({ phase: 'done' });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setRunning(false);
  }

  function handleReset() {
    onResultChange(null);
    setError(null);
    setProgress(null);
  }

  if (!paper) {
    return (
      <Placeholder
        title="论文解读"
        desc="先点上方「抽取本页」获取论文结构，然后在此生成结构化解读。"
      />
    );
  }

  return (
    <section className="space-y-3">
      {/* 元信息卡片 */}
      <div className="rounded border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {paper.title || '(未知标题)'}
        </h3>
        {paper.authors.length > 0 && (
          <p className="truncate text-slate-500 dark:text-slate-400">{paper.authors.join(', ')}</p>
        )}
      </div>

      {/* 控制栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={verbosity}
          onChange={(e) => setVerbosity(e.target.value as 'concise' | 'detailed')}
          disabled={running}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="concise">简洁</option>
          <option value="detailed">详细</option>
        </select>
        {!running ? (
          <button
            onClick={handleRun}
            className="rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700"
          >
            {result ? '重新生成解读' : '生成解读'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            停止
          </button>
        )}
        {result && !running && (
          <button
            onClick={handleReset}
            className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:border-brand-400 dark:border-slate-700 dark:text-slate-300"
          >
            清空
          </button>
        )}
        {result?.model && (
          <span className="text-[11px] text-slate-400">
            {result.providerId} / {result.model}
          </span>
        )}
      </div>

      {progress && running && <ProgressBar progress={progress} />}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {/* 思考过程（DeepSeek R1）折叠 */}
      {result?.reasoning && (
        <div className="rounded border border-amber-200 bg-amber-50/50 p-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/30">
          <button
            onClick={() => setShowReasoning((v) => !v)}
            className="flex w-full items-center justify-between text-amber-700 dark:text-amber-300"
          >
            <span>思考过程（模型内部推理）</span>
            <span>{showReasoning ? '收起' : '展开'}</span>
          </button>
          {showReasoning && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-amber-900 dark:text-amber-100">
              {result.reasoning}
            </pre>
          )}
        </div>
      )}

      {/* 解读内容 */}
      {result?.content ? (
        <MarkdownView content={result.content} />
      ) : !running ? (
        paper.kind === 'abs' ? (
          <div className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            当前是摘要页（/abs/），解读仅基于 Title + Abstract。若想获得更完整的解读，请切到论文的 HTML 或 ar5iv 版本后重新抽取。
          </div>
        ) : (
          <div className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            点「生成解读」开始流式输出。首次使用请先到扩展设置页填入 API Key。
          </div>
        )
      ) : null}
    </section>
  );
}

function ProgressBar({ progress }: { progress: SummarizeProgress }) {
  const label = phaseLabel(progress);
  return (
    <div className="flex items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
      <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
      <span>{label}</span>
    </div>
  );
}

function phaseLabel(p: SummarizeProgress): string {
  switch (p.phase) {
    case 'prepare':
      return '准备正文…';
    case 'mapping':
      return p.mapProgress
        ? `正在压缩长文章节：${p.mapProgress.current}/${p.mapProgress.total}`
        : '压缩长文中…';
    case 'reducing':
      return '正在生成最终解读（流式）…';
    case 'done':
      return '完成';
  }
}

function Placeholder({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900/40">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
      <p className="text-slate-500 dark:text-slate-400">{desc}</p>
    </div>
  );
}
