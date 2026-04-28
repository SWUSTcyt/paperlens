import { useEffect, useState } from 'react';
import type { PaperContent, Section } from '../../src/extractors/types';
import { requestExtractFromActiveTab } from '../../src/bridge/extractBridge';
import { SummaryTab, type SummaryResult } from './tabs/SummaryTab';
import { DerivationTab, type DerivationResult } from './tabs/DerivationTab';
import { ExportTab } from './tabs/ExportTab';

type TabKey = 'summary' | 'derivation' | 'export';

interface PageState {
  kind: 'abs' | 'html' | 'ar5iv' | 'unknown';
  url: string;
  title: string;
}

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'summary', label: '论文解读', hint: '结构化总结论文核心内容' },
  { key: 'derivation', label: '公式推导', hint: '逐步推导并拆解数学符号' },
  { key: 'export', label: '导出 Markdown', hint: '一键保存为 .md 文件' },
];

export default function App() {
  const [page, setPage] = useState<PageState | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('summary');
  const [paper, setPaper] = useState<PaperContent | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [derivations, setDerivations] = useState<Record<number, DerivationResult>>({});

  useEffect(() => {
    refreshActiveTab()
      .then(setPage)
      .catch((err) => {
        console.warn('[PaperLens] 获取当前页面信息失败：', err);
        setPage({ kind: 'unknown', url: '', title: '' });
      });

    const listener = (message: any) => {
      if (message?.type === 'PAGE_READY' && message.payload) {
        setPage({
          kind: message.payload.kind ?? 'unknown',
          url: message.payload.url ?? '',
          title: message.payload.title ?? '',
        });
        setPaper(null);
        setExtractError(null);
        setSummary(null);
        setDerivations({});
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const supported = page && page.kind !== 'unknown';

  async function handleExtract() {
    setExtracting(true);
    setExtractError(null);
    try {
      const data = await requestExtractFromActiveTab();
      setPaper(data);
      setSummary(null);
      setDerivations({});
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Header page={page} />

      <nav className="flex border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={
              'flex-1 px-3 py-2 text-sm transition-colors ' +
              (activeTab === t.key
                ? 'border-b-2 border-brand-500 font-semibold text-brand-600 dark:text-brand-300'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')
            }
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-4">
        {!supported ? (
          <UnsupportedHint />
        ) : (
          <>
            <ExtractBar
              paper={paper}
              extracting={extracting}
              error={extractError}
              onExtract={handleExtract}
            />
            {activeTab === 'summary' && (
              <SummaryTab paper={paper} result={summary} onResultChange={setSummary} />
            )}
            {activeTab === 'derivation' && (
              <DerivationTab
                paper={paper}
                results={derivations}
                onResultsChange={(updater) => setDerivations((prev) => updater(prev))}
              />
            )}
            {activeTab === 'export' && (
              <ExportTab paper={paper} summary={summary} derivations={derivations} />
            )}
          </>
        )}
      </main>

      <footer className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-xs text-slate-400 dark:border-slate-800">
        <span>PaperLens v0.0.1</span>
        <button
          className="text-brand-500 hover:underline dark:text-brand-300"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          设置 / 配置 API Key
        </button>
      </footer>
    </div>
  );
}

function Header({ page }: { page: PageState | null }) {
  return (
    <header className="border-b border-slate-200 bg-gradient-to-r from-brand-600 to-brand-400 px-4 py-3 text-white dark:border-slate-800">
      <h1 className="text-base font-bold tracking-wide">PaperLens</h1>
      <p className="truncate text-xs opacity-90">{page?.title || '等待检测当前页面…'}</p>
    </header>
  );
}

function ExtractBar({
  paper,
  extracting,
  error,
  onExtract,
}: {
  paper: PaperContent | null;
  extracting: boolean;
  error: string | null;
  onExtract: () => void;
}) {
  return (
    <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex items-center justify-between gap-2">
        <div className="text-slate-600 dark:text-slate-300">
          {paper ? (
            <>
              已抽取：<span className="font-medium">{paper.formulas.length}</span> 个公式 ·{' '}
              <span className="font-medium">{countSections(paper.sections)}</span> 个章节
            </>
          ) : (
            <>点击右侧按钮，从当前页抽取论文结构</>
          )}
        </div>
        <button
          className="rounded bg-brand-600 px-3 py-1 text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onExtract}
          disabled={extracting}
        >
          {extracting ? '抽取中…' : paper ? '重新抽取' : '抽取本页'}
        </button>
      </div>
      {error && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {paper && paper.warnings.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-xs text-amber-600 dark:text-amber-400">
          {paper.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UnsupportedHint() {
  return (
    <div className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      <p className="mb-2 font-medium text-slate-700 dark:text-slate-200">当前页面不是 arXiv 论文</p>
      <p>请在下列站点之一打开论文后再使用 PaperLens：</p>
      <ul className="mt-2 list-inside list-disc space-y-1">
        <li>
          arXiv 摘要页：<code className="rounded bg-slate-100 px-1 dark:bg-slate-800">arxiv.org/abs/...</code>
        </li>
        <li>
          arXiv HTML 全文页：<code className="rounded bg-slate-100 px-1 dark:bg-slate-800">arxiv.org/html/...</code>
        </li>
        <li>
          ar5iv 镜像：<code className="rounded bg-slate-100 px-1 dark:bg-slate-800">ar5iv.labs.arxiv.org/html/...</code>
        </li>
      </ul>
    </div>
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

async function refreshActiveTab(): Promise<PageState> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  const title = tab?.title ?? '';
  return { kind: classify(url), url, title };
}

function classify(url: string): PageState['kind'] {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('ar5iv.labs.arxiv.org') || u.hostname.endsWith('ar5iv.org')) {
      return 'ar5iv';
    }
    if (u.hostname.endsWith('arxiv.org')) {
      if (u.pathname.startsWith('/abs/')) return 'abs';
      if (u.pathname.startsWith('/html/')) return 'html';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function countSections(sections: Section[]): number {
  let n = 0;
  for (const s of sections) {
    n += 1 + countSections(s.children);
  }
  return n;
}
