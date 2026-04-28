// arXiv 页面抽取主入口：根据 URL 选择具体 extractor
// 所有细节实现在 abs.ts 与 latexml.ts 中

import type { ArxivPageKind, PaperContent } from './types';
import { extractFromAbs } from './abs';
import { extractFromLatexml } from './latexml';

/**
 * 根据 URL 推断页面类型；与 Content Script 里的 detectArxivPageKind 保持一致。
 */
export function detectKind(url: string): ArxivPageKind | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('ar5iv.labs.arxiv.org') || u.hostname.endsWith('ar5iv.org')) {
      return 'ar5iv';
    }
    if (u.hostname.endsWith('arxiv.org')) {
      if (u.pathname.startsWith('/abs/')) return 'abs';
      if (u.pathname.startsWith('/html/')) return 'html';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 在给定的 Document 上运行对应 extractor，返回结构化 PaperContent。
 * 抛出异常会被上层 Content Script 捕获并以错误消息返回给 SidePanel。
 */
export function extractPaper(doc: Document, url: string): PaperContent {
  const kind = detectKind(url);
  if (!kind) {
    throw new Error('当前页面不是受支持的 arXiv 页（需要 /abs/、/html/ 或 ar5iv）');
  }
  if (kind === 'abs') {
    return extractFromAbs(doc, url);
  }
  return extractFromLatexml(doc, url, kind);
}
