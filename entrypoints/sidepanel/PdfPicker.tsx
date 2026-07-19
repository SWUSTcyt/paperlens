import { useRef, useState, type DragEvent } from 'react';
import type { PdfExtractionProgress } from '../../src/pdf/progress';

interface Props {
  busy: boolean;
  progress: PdfExtractionProgress | null;
  onPick: (file: File) => Promise<void>;
}

/** 上传/拖拽 PDF 兜底入口；文件字节由调用方解析，不在组件内持久化。 */
export function PdfPicker({ busy, progress, onPick }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    try {
      await onPick(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void submit(event.dataTransfer.files?.[0]);
  }

  return (
    <div className="mb-4">
      <div
        className={
          'rounded-md border border-dashed p-3 text-center text-xs transition-colors ' +
          (dragging
            ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/30 dark:text-brand-200'
            : 'border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400')
        }
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={(event) => void submit(event.target.files?.[0])}
        />
        <span>
          {busy
            ? progress
              ? `正在解析 PDF：${progress.currentPage}/${progress.totalPages} 页`
              : '正在解析 PDF…'
            : '也可以把 PDF 拖到这里，或'}
        </span>{' '}
        {!busy && (
          <button
            type="button"
            className="font-medium text-brand-600 hover:underline dark:text-brand-300"
            onClick={() => inputRef.current?.click()}
          >
            选择本地文件
          </button>
        )}
        <p className="mt-1 text-[11px] text-slate-400">
          文件只在本机内存中解析，原始 PDF 不会写入浏览器缓存。
        </p>
        {busy && progress && (
          <div className="mx-auto mt-2 h-1.5 max-w-64 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-brand-500 transition-[width]"
              style={{ width: `${Math.round((progress.currentPage / progress.totalPages) * 100)}%` }}
            />
          </div>
        )}
      </div>
      {error && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
