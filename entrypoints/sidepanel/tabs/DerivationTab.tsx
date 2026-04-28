import { useMemo, useRef, useState } from 'react';
import type { Formula, PaperContent } from '../../../src/extractors/types';
import { derivePipeline } from '../../../src/pipelines/derive';
import { MarkdownView } from '../../../src/components/MarkdownView';
import { renderLatexToHtml } from '../../../src/formula/mathMarkdown';
import { requestScrollToFormula } from '../../../src/bridge/extractBridge';

export interface DerivationResult {
  content: string;
  reasoning: string;
  providerId?: string;
  model?: string;
  generatedAt?: number;
}

interface Props {
  paper: PaperContent | null;
  results: Record<number, DerivationResult>;
  onResultsChange: (updater: (prev: Record<number, DerivationResult>) => Record<number, DerivationResult>) => void;
}

export function DerivationTab({ paper, results, onResultsChange }: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  if (!paper) {
    return (
      <Placeholder
        title="公式推导"
        desc="先点上方「抽取本页」获取公式列表，然后选择某条公式生成逐步推导。"
      />
    );
  }

  if (paper.formulas.length === 0) {
    return (
      <Placeholder
        title="公式推导"
        desc={
          paper.kind === 'abs'
            ? '当前是摘要页（/abs/），不含 <math> 公式。请打开论文的 HTML 或 ar5iv 版本后再抽取。'
            : '此页未抽到公式。可能该论文不含 <math> 标签。'
        }
      />
    );
  }

  const selected = selectedId != null ? paper.formulas.find((f) => f.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <DerivationDetail
        paper={paper}
        formula={selected}
        result={results[selected.id] ?? null}
        onResultChange={(r) =>
          onResultsChange((prev) => ({ ...prev, [selected.id]: r }))
        }
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <FormulaList
      paper={paper}
      query={query}
      onQueryChange={setQuery}
      results={results}
      onSelect={setSelectedId}
    />
  );
}

/* ---------------- 列表视图 ---------------- */

function FormulaList({
  paper,
  query,
  onQueryChange,
  results,
  onSelect,
}: {
  paper: PaperContent;
  query: string;
  onQueryChange: (v: string) => void;
  results: Record<number, DerivationResult>;
  onSelect: (id: number) => void;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return paper.formulas;
    return paper.formulas.filter(
      (f) =>
        f.latex.toLowerCase().includes(q) ||
        (f.sectionPath ?? '').toLowerCase().includes(q),
    );
  }, [paper.formulas, query]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="过滤 LaTeX / 章节…"
          className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-brand-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900"
        />
        <span className="text-xs text-slate-400">
          {filtered.length}/{paper.formulas.length}
        </span>
      </div>

      <ul className="space-y-2">
        {filtered.map((f) => (
          <li key={f.id}>
            <FormulaCard
              formula={f}
              hasResult={!!results[f.id]}
              onOpen={() => onSelect(f.id)}
            />
          </li>
        ))}
      </ul>

      {filtered.length === 0 && (
        <p className="text-xs text-slate-400">未匹配到公式，尝试换个关键字。</p>
      )}
    </section>
  );
}

function FormulaCard({
  formula,
  hasResult,
  onOpen,
}: {
  formula: Formula;
  hasResult: boolean;
  onOpen: () => void;
}) {
  const html = useMemo(
    () => renderLatexToHtml(formula.latex, formula.display),
    [formula.latex, formula.display],
  );

  return (
    <div className="rounded border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
        <span>#{formula.id}</span>
        <span>{formula.display ? 'block' : 'inline'}</span>
        {formula.sectionPath && <span className="truncate">· {formula.sectionPath}</span>}
        {hasResult && (
          <span className="ml-auto rounded bg-brand-500/10 px-1.5 py-0.5 text-brand-600 dark:text-brand-300">
            已生成
          </span>
        )}
      </div>
      <div
        className="overflow-x-auto py-1 text-sm"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className="mt-2 flex gap-2">
        <button
          onClick={onOpen}
          className="rounded bg-brand-600 px-2 py-0.5 text-xs text-white hover:bg-brand-700"
        >
          {hasResult ? '查看推导' : '生成推导'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 详情视图 ---------------- */

function DerivationDetail({
  paper,
  formula,
  result,
  onResultChange,
  onBack,
}: {
  paper: PaperContent;
  formula: Formula;
  result: DerivationResult | null;
  onResultChange: (r: DerivationResult) => void;
  onBack: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const formulaHtml = useMemo(
    () => renderLatexToHtml(formula.latex, formula.display),
    [formula.latex, formula.display],
  );

  async function handleRun() {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    let content = '';
    let reasoning = '';
    let providerId: string | undefined;
    let model: string | undefined;

    try {
      for await (const chunk of derivePipeline(paper, formula, { signal: controller.signal })) {
        if (chunk.type === 'ready') {
          providerId = chunk.providerId;
          model = chunk.model;
        } else if (chunk.type === 'delta') {
          if (chunk.content) content += chunk.content;
          if (chunk.reasoning) reasoning += chunk.reasoning;
          onResultChange({ content, reasoning, providerId, model, generatedAt: Date.now() });
        } else if (chunk.type === 'error') {
          throw new Error(chunk.message || '未知错误');
        }
      }
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

  async function handleScrollBack() {
    try {
      await requestScrollToFormula(formula.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="space-y-3">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-xs text-brand-600 hover:underline dark:text-brand-300"
        >
          ← 返回公式列表
        </button>
        <span className="text-[11px] text-slate-400">
          #{formula.id} {formula.sectionPath && `· ${formula.sectionPath}`}
        </span>
      </div>

      {/* 公式展示（KaTeX） */}
      <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-2 text-[11px] text-slate-400">目标公式</div>
        <div
          className="overflow-x-auto py-1 text-sm"
          dangerouslySetInnerHTML={{ __html: formulaHtml }}
        />
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600">
            查看原始 LaTeX
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 text-[11px] dark:bg-slate-800/60">
            {formula.latex}
          </pre>
        </details>
      </div>

      {/* 控制栏 */}
      <div className="flex flex-wrap items-center gap-2">
        {!running ? (
          <button
            onClick={handleRun}
            className="rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700"
          >
            {result ? '重新推导' : '生成推导'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            停止
          </button>
        )}
        <button
          onClick={handleScrollBack}
          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-brand-400 dark:border-slate-700 dark:text-slate-300"
        >
          回跳原文
        </button>
        {result?.model && (
          <span className="text-[11px] text-slate-400">
            {result.providerId} / {result.model}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {/* 思考过程折叠 */}
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

      {/* 推导结果 */}
      {result?.content ? (
        <MarkdownView content={result.content} />
      ) : !running ? (
        <div className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
          点「生成推导」开始流式输出。PaperLens 会给出符号拆解、逐步推导与小例子。
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
          <span>正在生成推导（流式）…</span>
        </div>
      )}
    </section>
  );
}

function Placeholder({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900/40">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
      <p className="text-slate-500 dark:text-slate-400">{desc}</p>
    </div>
  );
}
