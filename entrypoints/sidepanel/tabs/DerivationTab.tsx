import { useMemo, useRef, useState } from 'react';
import type { Formula, PaperContent, Section } from '../../../src/extractors/types';
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

/** 去重后的一条公式条目（记录相同 latex 的出现次数） */
interface FormulaEntry {
  formula: Formula;
  count: number;
}

/** 一个章节分组：主公式（display + 复杂行内）与符号（单变量/短公式）分层，但都可点 */
interface SectionGroup {
  key: string;
  heading: string;
  depth: number;
  main: FormulaEntry[];
  symbols: FormulaEntry[];
}

/**
 * 单变量 / 极短行内公式：作为"符号"弱化展示（排后、变小），但绝不隐藏，
 * 以照顾数学基础较弱的用户逐个点开学习符号含义。
 */
function isSymbolFormula(f: Formula): boolean {
  return !f.display && f.latex.trim().length <= 2;
}

/** 对一组公式：合并完全相同的 latex（累计次数），再拆成"主公式 / 符号"两层 */
function dedupAndTier(formulas: Formula[]): { main: FormulaEntry[]; symbols: FormulaEntry[] } {
  const seen = new Map<string, FormulaEntry>();
  const order: FormulaEntry[] = [];
  for (const f of formulas) {
    const key = f.latex.trim();
    const exist = seen.get(key);
    if (exist) {
      exist.count += 1;
      continue;
    }
    const entry: FormulaEntry = { formula: f, count: 1 };
    seen.set(key, entry);
    order.push(entry);
  }
  const main = order.filter((e) => !isSymbolFormula(e.formula));
  // display 块级公式排在前面，其余保持原文顺序（稳定排序）
  main.sort((a, b) => Number(b.formula.display) - Number(a.formula.display));
  const symbols = order.filter((e) => isSymbolFormula(e.formula));
  return { main, symbols };
}

/** 按章节树把公式分组（文档顺序；depth 用于缩进展示） */
function buildSectionGroups(
  sections: Section[],
  byId: Map<number, Formula>,
  keep: (f: Formula) => boolean,
  depth = 0,
): SectionGroup[] {
  const out: SectionGroup[] = [];
  sections.forEach((s, idx) => {
    const fs = s.formulaIds
      .map((id) => byId.get(id))
      .filter((f): f is Formula => !!f && keep(f));
    if (fs.length > 0) {
      const { main, symbols } = dedupAndTier(fs);
      out.push({
        key: `${depth}-${idx}-${s.heading}`,
        heading: s.heading || '(前言)',
        depth,
        main,
        symbols,
      });
    }
    out.push(...buildSectionGroups(s.children, byId, keep, depth + 1));
  });
  return out;
}

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
  const byId = useMemo(() => {
    const m = new Map<number, Formula>();
    for (const f of paper.formulas) m.set(f.id, f);
    return m;
  }, [paper.formulas]);

  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const keep = (f: Formula) =>
      !q ||
      f.latex.toLowerCase().includes(q) ||
      (f.sectionPath ?? '').toLowerCase().includes(q);

    const gs = buildSectionGroups(paper.sections, byId, keep);

    // 兜底：不在任何章节 formulaIds 里的公式（理论上少见）归入"其他公式"
    const covered = new Set<number>();
    const walk = (secs: Section[]) => {
      for (const s of secs) {
        s.formulaIds.forEach((id) => covered.add(id));
        walk(s.children);
      }
    };
    walk(paper.sections);
    const orphans = paper.formulas.filter((f) => !covered.has(f.id) && keep(f));
    if (orphans.length > 0) {
      const { main, symbols } = dedupAndTier(orphans);
      gs.push({ key: 'orphans', heading: '其他公式', depth: 0, main, symbols });
    }
    return gs;
  }, [paper.sections, paper.formulas, byId, q]);

  const shown = groups.reduce((n, g) => n + g.main.length + g.symbols.length, 0);

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
        <span className="whitespace-nowrap text-xs text-slate-400">
          {shown} 项 · {paper.formulas.length} 处
        </span>
      </div>

      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.key} className="space-y-2">
            {/* 章节标题（按层级缩进） */}
            <div
              className="flex items-center gap-1 border-l-2 border-brand-400/60 pl-2 text-xs font-semibold text-slate-600 dark:text-slate-300"
              style={{ marginLeft: g.depth * 10 }}
              title={g.heading}
            >
              <span className="truncate">{g.heading}</span>
              <span className="ml-1 font-normal text-slate-400">
                {g.main.length + g.symbols.length}
              </span>
            </div>

            {/* 主公式：display + 复杂行内 */}
            {g.main.length > 0 && (
              <ul className="space-y-2" style={{ marginLeft: g.depth * 10 }}>
                {g.main.map((e) => (
                  <li key={e.formula.id}>
                    <FormulaCard
                      formula={e.formula}
                      count={e.count}
                      hasResult={!!results[e.formula.id]}
                      onOpen={() => onSelect(e.formula.id)}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* 符号与变量：弱化为小 chip，但同样可点开学习 */}
            {g.symbols.length > 0 && (
              <div className="flex flex-wrap gap-1.5" style={{ marginLeft: g.depth * 10 }}>
                {g.symbols.map((e) => (
                  <SymbolChip
                    key={e.formula.id}
                    formula={e.formula}
                    count={e.count}
                    hasResult={!!results[e.formula.id]}
                    onOpen={() => onSelect(e.formula.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {shown === 0 && (
        <p className="text-xs text-slate-400">
          {q ? '未匹配到公式，尝试换个关键字。' : '此页未抽到公式。'}
        </p>
      )}
    </section>
  );
}

function FormulaCard({
  formula,
  count,
  hasResult,
  onOpen,
}: {
  formula: Formula;
  count: number;
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
        {count > 1 && (
          <span
            className="rounded bg-slate-100 px-1 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            title={`本节出现 ${count} 处`}
          >
            ×{count}
          </span>
        )}
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

/** 符号 / 短公式的紧凑展示：点击即可打开推导（对符号即"含义 + 小例子"） */
function SymbolChip({
  formula,
  count,
  hasResult,
  onOpen,
}: {
  formula: Formula;
  count: number;
  hasResult: boolean;
  onOpen: () => void;
}) {
  const html = useMemo(
    () => renderLatexToHtml(formula.latex, false),
    [formula.latex],
  );

  return (
    <button
      onClick={onOpen}
      title={hasResult ? '查看该符号的解释' : '点击了解该符号含义'}
      className={
        'inline-flex items-center gap-1 rounded border px-2 py-1 text-xs transition ' +
        (hasResult
          ? 'border-brand-300 bg-brand-500/10 dark:border-brand-700'
          : 'border-slate-200 bg-white hover:border-brand-400 dark:border-slate-800 dark:bg-slate-900')
      }
    >
      <span className="pointer-events-none" dangerouslySetInnerHTML={{ __html: html }} />
      {count > 1 && <span className="text-[10px] text-slate-400">×{count}</span>}
    </button>
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
