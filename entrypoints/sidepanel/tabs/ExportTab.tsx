import { useMemo, useState } from 'react';
import type { PaperContent } from '../../../src/extractors/types';
import { buildMarkdown, suggestFilename } from '../../../src/export/markdown';
import { downloadMarkdown } from '../../../src/export/download';
import type { SummaryResult } from './SummaryTab';
import type { DerivationResult } from './DerivationTab';

interface Props {
  paper: PaperContent | null;
  summary: SummaryResult | null;
  derivations: Record<number, DerivationResult>;
}

export function ExportTab({ paper, summary, derivations }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const markdown = useMemo(() => {
    if (!paper) return '';
    return buildMarkdown({ paper, summary, derivations });
  }, [paper, summary, derivations]);

  const filename = useMemo(() => (paper ? suggestFilename(paper) : 'paperlens.md'), [paper]);

  if (!paper) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900/40">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">导出 Markdown</h2>
        <p className="text-slate-500 dark:text-slate-400">
          先在上方点「抽取本页」，然后生成解读或公式推导，再回到这里一键导出。
        </p>
      </div>
    );
  }

  const summaryReady = !!summary?.content;
  const derivedCount = Object.values(derivations).filter((d) => d.content).length;

  async function handleDownload(saveAs: boolean) {
    setDownloading(true);
    setMessage(null);
    try {
      await downloadMarkdown(markdown, filename, { saveAs });
      setMessage({ kind: 'ok', text: `已开始下载：${filename}` });
    } catch (err) {
      setMessage({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDownloading(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setMessage({
        kind: 'err',
        text: `复制失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return (
    <section className="space-y-3">
      {/* 概览 */}
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <StatusCell
          label="论文结构"
          value={`${countSections(paper)} 章节`}
          ok
        />
        <StatusCell
          label="解读"
          value={summaryReady ? '已生成' : '未生成'}
          ok={summaryReady}
        />
        <StatusCell
          label="公式推导"
          value={`${derivedCount} / ${paper.formulas.length}`}
          ok={derivedCount > 0}
        />
      </div>

      {/* 操作区 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => handleDownload(true)}
          disabled={downloading}
          className="rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {downloading ? '导出中…' : '导出 .md（选择位置）'}
        </button>
        <button
          onClick={() => handleDownload(false)}
          disabled={downloading}
          className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:border-brand-400 dark:border-slate-700 dark:text-slate-300"
        >
          直接保存到下载目录
        </button>
        <button
          onClick={handleCopy}
          className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:border-brand-400 dark:border-slate-700 dark:text-slate-300"
        >
          {copied ? '已复制' : '复制 Markdown'}
        </button>
      </div>

      {/* 提示 */}
      {!summaryReady && derivedCount === 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          当前尚未生成任何解读或推导，导出的文件只会包含论文元信息与公式清单。建议先在前两个标签页至少生成一项再导出。
        </div>
      )}

      {message && (
        <div
          className={
            'rounded border p-2 text-xs ' +
            (message.kind === 'ok'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
              : 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200')
          }
        >
          {message.text}
        </div>
      )}

      {/* 文件名 + 预览 */}
      <div className="rounded border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-1 text-slate-400">推荐文件名</div>
        <code className="break-all text-slate-700 dark:text-slate-200">{filename}</code>
      </div>

      <details className="rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <summary className="cursor-pointer border-b border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 dark:border-slate-800 dark:text-slate-300">
          预览 Markdown 源文本（{markdown.length} 字符）
        </summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] text-slate-700 dark:text-slate-200">
          {markdown}
        </pre>
      </details>
    </section>
  );
}

function StatusCell({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div
      className={
        'rounded border p-2 ' +
        (ok
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
          : 'border-slate-300 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-400')
      }
    >
      <div className="text-[10px] uppercase tracking-wide">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function countSections(paper: PaperContent): number {
  let n = 0;
  const walk = (arr: { children: typeof paper.sections }[]) => {
    for (const s of arr as any) {
      n += 1;
      if (s.children) walk(s.children);
    }
  };
  walk(paper.sections as any);
  return n;
}
