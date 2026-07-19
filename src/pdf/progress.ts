export interface PdfExtractionProgress {
  currentPage: number;
  totalPages: number;
}

export interface PdfProgressOptions {
  onProgress?: (progress: PdfExtractionProgress) => void;
  /** 默认每页让出一次；调大可减少极大文档中的调度次数。 */
  yieldEveryPages?: number;
  /** 测试注入点；业务代码使用默认的 setTimeout(0)。 */
  yieldTask?: () => Promise<void>;
}

/** 报告已完成页，并定期把控制权还给 SidePanel 的渲染循环。 */
export async function reportPdfPageProgress(
  currentPage: number,
  totalPages: number,
  options: PdfProgressOptions = {},
): Promise<void> {
  try {
    options.onProgress?.({ currentPage, totalPages });
  } catch (err) {
    console.warn('[PaperLens] PDF 进度回调失败：', err);
  }
  const interval = Math.max(1, options.yieldEveryPages ?? 1);
  if (currentPage % interval !== 0 && currentPage !== totalPages) return;
  const yieldTask = options.yieldTask ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  await yieldTask();
}
