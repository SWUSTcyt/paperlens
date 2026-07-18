import { useEffect, useRef, useState } from 'react';
import type { PaperContent, Section } from '../../src/extractors/types';
import { requestExtractFromActiveTab } from '../../src/bridge/extractBridge';
import { detectKind } from '../../src/extractors/arxiv';
import { loadPageCache, savePageCache } from '../../src/storage/cache';
import { loadSettings, onSettingsChanged } from '../../src/storage/settings';
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
  // 已完成"缓存恢复"的 URL：用于门控持久化，避免在恢复完成前把空状态写回缓存
  const [hydratedUrl, setHydratedUrl] = useState<string>('');
  // 是否尚未配置任何 Provider 的 API Key（用于首次使用引导）
  const [needsApiKey, setNeedsApiKey] = useState(false);
  // 当前页面 URL 的引用，供异步切换时判断是否已被后续切换覆盖
  const currentUrlRef = useRef<string>('');

  // 切换到某个页面：更新页面信息，并按 URL 从会话缓存恢复已生成的内容
  async function switchToPage(next: PageState) {
    if (next.url === currentUrlRef.current && page) return; // 同一页，无需切换
    currentUrlRef.current = next.url;
    setPage(next);
    setExtractError(null);

    const cache = next.url ? await loadPageCache(next.url) : null;
    // 若加载期间用户又切换了页面，放弃本次恢复，避免把旧页数据套到新页
    if (currentUrlRef.current !== next.url) return;

    setPaper(cache?.paper ?? null);
    setSummary(cache?.summary ?? null);
    setDerivations(cache?.derivations ?? {});
    setHydratedUrl(next.url);
  }

  // 同步"当前活动标签页"的页面状态（切标签 / 页内跳转 / content 通知时调用）
  async function syncActiveTab() {
    try {
      const st = await refreshActiveTab();
      await switchToPage(st);
    } catch (err) {
      console.warn('[PaperLens] 获取当前页面信息失败：', err);
      await switchToPage({ kind: 'unknown', url: '', title: '' });
    }
  }

  // 监听标签页切换、URL 变化以及 content script 的 PAGE_READY，保持侧边栏与当前页一致
  useEffect(() => {
    void syncActiveTab();

    const onActivated = () => {
      void syncActiveTab();
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: { url?: string; status?: string },
      tab: chrome.tabs.Tab,
    ) => {
      // 只关心"当前活动标签页"的 URL 变化或加载完成
      if (tab?.active && (changeInfo.url || changeInfo.status === 'complete')) {
        void syncActiveTab();
      }
    };
    const onMessage = (message: any) => {
      if (message?.type === 'PAGE_READY') {
        void syncActiveTab();
      }
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
    // 仅在挂载时注册一次；内部通过 ref 判断，无需依赖变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 抽取/解读/推导结果变化时，写入该 URL 的会话缓存（恢复完成后才写，避免覆盖）
  useEffect(() => {
    if (!page?.url || hydratedUrl !== page.url) return;
    void savePageCache(page.url, {
      paper,
      summary,
      derivations,
      savedAt: Date.now(),
    });
  }, [page?.url, hydratedUrl, paper, summary, derivations]);

  // 检查是否已配置任一 Provider 的 API Key；设置变更时实时刷新引导条
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const s = await loadSettings();
        const anyKey = Object.values(s.providers).some(
          (p) => p.apiKey && p.apiKey.trim().length > 0,
        );
        if (!disposed) setNeedsApiKey(!anyKey);
      } catch (err) {
        console.warn('[PaperLens] 读取设置失败：', err);
      }
    };
    void check();
    const off = onSettingsChanged(() => void check());
    return () => {
      disposed = true;
      off();
    };
  }, []);

  const supported = page && page.kind !== 'unknown';

  async function handleExtract() {
    setExtracting(true);
    setExtractError(null);
    try {
      const data = await requestExtractFromActiveTab();
      setPaper(data);
      // 重新抽取视为对当前页的一次刷新，清空旧的解读与推导
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

      {needsApiKey && <ApiKeyBanner />}

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

function ApiKeyBanner() {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      <span>尚未配置 API Key，暂时无法生成解读与推导。</span>
      <button
        onClick={() => chrome.runtime.openOptionsPage()}
        className="shrink-0 rounded bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700"
      >
        去设置
      </button>
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

// 复用抽取器里的 detectKind，避免页面类型判定逻辑在两处漂移
function classify(url: string): PageState['kind'] {
  return detectKind(url) ?? 'unknown';
}

function countSections(sections: Section[]): number {
  let n = 0;
  for (const s of sections) {
    n += 1 + countSections(s.children);
  }
  return n;
}
