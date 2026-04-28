// arXiv 摘要页 /abs/xxxx.xxxxx 的抽取器
// DOM 结构参考：https://arxiv.org/abs/2310.06825
// - h1.title                标题（含前缀 "Title:"）
// - div.authors             作者列表（<a> 为作者）
// - blockquote.abstract     摘要（含前缀 "Abstract:"）
// - td.subjects             分类（Subjects: cs.CL; cs.AI 形式）

import { createEmptyPaper, parseArxivId, type PaperContent } from './types';

export function extractFromAbs(doc: Document, url: string): PaperContent {
  const paper = createEmptyPaper('abs', url);
  paper.arxivId = parseArxivId(url, doc);

  // 标题：去掉前缀 "Title:" 前导文本
  const titleEl = doc.querySelector('h1.title');
  paper.title = stripPrefix(titleEl?.textContent ?? '', 'Title:');
  if (!paper.title) paper.warnings.push('未能从 h1.title 抽取标题');

  // 作者：优先 .authors a，回退到整块文本去前缀
  const authorLinks = Array.from(doc.querySelectorAll('.authors a')) as HTMLElement[];
  if (authorLinks.length > 0) {
    paper.authors = authorLinks
      .map((a) => a.textContent?.trim() ?? '')
      .filter(Boolean);
  } else {
    const authorsBlock = stripPrefix(
      doc.querySelector('.authors')?.textContent ?? '',
      'Authors:',
    );
    paper.authors = authorsBlock
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (paper.authors.length === 0) paper.warnings.push('未能抽取作者');

  // 摘要
  const absEl = doc.querySelector('blockquote.abstract');
  paper.abstract = stripPrefix(absEl?.textContent ?? '', 'Abstract:').trim();
  if (!paper.abstract) paper.warnings.push('未能抽取摘要');

  // 分类 Subjects
  const subjectsEl = doc.querySelector('td.tablecell.subjects, td.subjects');
  if (subjectsEl?.textContent) {
    paper.categories = subjectsEl.textContent
      .split(';')
      .map((s) => s.replace(/\([^)]*\)/g, '').trim())
      .filter(Boolean);
  }

  // abs 页不含全文，sections 保持空；上层 UI 会提示"跳转 HTML 页可获得完整解读"
  return paper;
}

function stripPrefix(text: string, prefix: string): string {
  const t = text.trim();
  if (t.toLowerCase().startsWith(prefix.toLowerCase())) {
    return t.slice(prefix.length).trim();
  }
  return t;
}
