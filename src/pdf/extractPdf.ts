// PDF 字节 → PaperContent 抽取管线（文本/章节结构 + 实验性公式候选）
//
// 设计原则：
// 1. 归一到与 arXiv 抽取器一致的 PaperContent，使下游 Summary / Export 对来源透明。
// 2. 健壮性优先：任何一步失败都降级为"整篇纯文本"，并在 warnings 里如实告知，
//    保证「论文解读」在结构识别不理想时仍可用。
// 3. 公式只做启发式候选；质量不足或识别异常时保持 formulaSupport = 'none'。
//
// 处理流程：每页取带坐标的文本片段 → 分栏 → 聚行 → 去页眉页脚 → 去连字符/分段
//          → 识别标题/摘要/章节/参考文献 → 组装 PaperContent。

import {
  createEmptyPaper,
  parseArxivId,
  type PaperContent,
  type Section,
} from '../extractors/types';
import { loadPdfjs } from './loadPdfjs';
import {
  assignFormulaIdsToSections,
  detectPdfFormulaCandidates,
  isMathFontName,
} from './formulaHeuristic';
import { reportPdfPageProgress, type PdfProgressOptions } from './progress';
import { detectHeading, parseAuthorLines, parseReferences } from './structure';
import {
  buildPageLines,
  joinLines as joinLayoutLines,
  shouldStartParagraph,
  stripHeadersFooters,
  type LayoutLine as Line,
  type RawItem,
} from './textLayout';

/** pdf.js 文本片段的最小结构（避免深引用其内部类型路径） */
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

interface PdfTextStyle {
  fontFamily?: string;
}

/**
 * 主入口：解析 PDF 字节，返回 PaperContent。
 * @param data PDF 原始字节
 * @param url  该 PDF 的地址（arXiv /pdf/ 链接或合成 key），用于缓存与 arxivId 推断
 */
export type ExtractPdfOptions = PdfProgressOptions;

export async function extractPdf(
  data: ArrayBuffer,
  url: string,
  options: ExtractPdfOptions = {},
): Promise<PaperContent> {
  const paper = createEmptyPaper('html', url); // kind 占位；下方标注 source='pdf'
  paper.source = 'pdf';
  paper.formulaSupport = 'none';
  paper.arxivId = parseArxivId(url);

  const pdfjs = await loadPdfjs();
  // pdf.js 需要独占 buffer，复制一份避免 detached 问题
  const loadingTask = pdfjs.getDocument({ data: data.slice(0) });
  const doc = await loadingTask.promise;
  paper.pageCount = doc.numPages;

  try {
    // 1. 逐页抽取并重建行
    const allLines: Line[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      try {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const styles = (content as unknown as { styles?: Record<string, PdfTextStyle> }).styles;
        const items = normalizeItems(content.items as unknown as PdfTextItem[], styles);
        if (items.length === 0) continue;
        const lines = buildPageLines(items, viewport.width, viewport.height, p);
        allLines.push(...lines);
      } catch (err) {
        paper.warnings.push(`第 ${p} 页解析失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await reportPdfPageProgress(p, doc.numPages, options);
      }
    }

    if (allLines.length === 0) {
      paper.warnings.push('未能从 PDF 提取到任何文本，可能是扫描版（无文本层）PDF。');
      return paper;
    }

    // 2. 去页眉页脚；异常或过度清洗时回退原始阅读序列
    let bodyLines = allLines;
    try {
      const cleaned = stripHeadersFooters(allLines);
      if (cleaned.length > 0) bodyLines = cleaned;
      else paper.warnings.push('页眉页脚清洗结果为空，已保留原始文本顺序。');
    } catch (err) {
      paper.warnings.push(`页眉页脚清洗失败，已保留原始文本：${formatError(err)}`);
    }

    // 3. 估计正文字号（用于标题判定与分段）
    const bodySize = estimateBodySize(bodyLines);

    // 4–5. 提取前置信息、章节树与参考文献；失败时整篇纯文本降级
    try {
      const consumed = new Set<Line>();
      extractFrontMatter(paper, bodyLines, bodySize, consumed);
      buildSectionsAndRefs(paper, bodyLines, bodySize, consumed);
    } catch (err) {
      paper.sections = [];
      paper.references = [];
      paper.warnings.push(`结构识别失败，已降级为整篇纯文本：${formatError(err)}`);
    }

    // 6. 兜底：无章节时退化为整篇纯文本单节，保证解读可用
    if (paper.sections.length === 0) {
      const text = joinLines(bodyLines.map((line) => line.text));
      const paragraphs = splitIntoParagraphs(text);
      if (paragraphs.length > 0) {
        paper.sections.push({
          level: 1,
          heading: '正文',
          paragraphs,
          formulaIds: [],
          children: [],
        });
      }
      paper.warnings.push('未能识别章节结构，已退化为整篇纯文本（解读仍可用，但结构可能不准）。');
    }

    // 7. 实验性公式候选：失败或质量不足都回到 none，不影响正文与解读。
    try {
      const formulaResult = detectPdfFormulaCandidates(bodyLines, bodySize, detectHeading);
      paper.formulas = formulaResult.formulas.map((formula) => ({
        ...formula,
        recognitionSource: 'pdf-heuristic' as const,
      }));
      paper.formulaSupport = formulaResult.formulaSupport;
      if (formulaResult.formulaSupport === 'heuristic') {
        assignFormulaIdsToSections(paper.sections, paper.formulas);
      }
    } catch (err) {
      paper.formulas = [];
      paper.formulaSupport = 'none';
      paper.warnings.push(`公式候选识别失败，已关闭实验性公式功能：${formatError(err)}`);
    }

    return paper;
  } finally {
    try {
      await loadingTask.destroy();
    } catch (err) {
      console.warn('[PaperLens] 释放 PDF 解析资源失败：', err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 版面重建                                                            */
/* ------------------------------------------------------------------ */

/** 归一 pdf.js 文本片段：过滤空串，换算坐标与字号 */
function normalizeItems(
  items: PdfTextItem[],
  styles: Record<string, PdfTextStyle> = {},
): RawItem[] {
  const out: RawItem[] = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || it.str.trim() === '') continue;
    const t = it.transform || [];
    const x = t[4] ?? 0;
    const y = t[5] ?? 0;
    // 字号优先用 height；缺失时由变换矩阵推导
    const size = it.height && it.height > 0 ? it.height : Math.hypot(t[1] ?? 0, t[3] ?? 0) || 10;
    const font = styles[it.fontName]?.fontFamily || it.fontName || '';
    out.push({
      str: it.str,
      x,
      y,
      w: it.width ?? 0,
      size,
      font,
      mathFont: isMathFontName(font),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 结构：标题 / 作者 / 摘要                                             */
/* ------------------------------------------------------------------ */

/** 提取标题、作者、摘要，并把消费掉的行登记进 consumed */
function extractFrontMatter(
  paper: PaperContent,
  lines: Line[],
  bodySize: number,
  consumed: Set<Line>,
): void {
  const page1 = lines.filter((l) => l.page === 1);
  if (page1.length === 0) {
    paper.warnings.push('第 1 页无文本，无法提取标题。');
    return;
  }
  // 标题：第 1 页字号最大的行（可能连续多行），取靠上的一簇
  const maxSize = Math.max(...page1.map((l) => l.size));
  const titleLines: Line[] = [];
  for (const l of page1) {
    if (l.size >= maxSize * 0.95 && l.text.length >= 4) {
      titleLines.push(l);
      if (titleLines.length >= 3) break; // 标题一般不超过 3 行
    }
  }
  if (titleLines.length > 0) {
    paper.title = joinLines(titleLines.map((t) => t.text));
    titleLines.forEach((t) => consumed.add(t));
  } else {
    paper.warnings.push('未能识别标题。');
  }

  // 摘要：定位以 "Abstract" 起始的行，收集其后若干行直到下一个标题/Introduction
  const absIdx = lines.findIndex((l) => /^abstract\b/i.test(l.text.trim()));
  if (absIdx >= 0) {
    const absLine = lines[absIdx];
    consumed.add(absLine);
    const buf: string[] = [];
    // "Abstract" 同一行可能已带正文
    const inline = absLine.text.replace(/^abstract[:.\s-]*/i, '').trim();
    if (inline) buf.push(inline);
    for (let i = absIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      const t = l.text.trim();
      if (/^(1\b|1\.|i\.|introduction\b)/i.test(t) || detectHeading(l, bodySize)) break;
      if (/^index terms|^keywords/i.test(t)) {
        consumed.add(l);
        break;
      }
      buf.push(t);
      consumed.add(l);
      if (buf.join(' ').length > 3000) break; // 摘要不至于太长
    }
    paper.abstract = joinLines(buf).trim();
  } else {
    paper.warnings.push('未能定位摘要（Abstract）。');
  }

  // 作者：标题与摘要之间的行（best-effort）
  if (titleLines.length > 0) {
    const lastTitleY = Math.min(...titleLines.map((t) => t.y));
    const between = page1.filter(
      (l) => !consumed.has(l) && l.y < lastTitleY && l.size <= maxSize * 0.9,
    );
    const authorLines = between
      .sort((a, b) => b.y - a.y)
      .slice(0, 8)
      .map((line) => line.text);
    paper.authors = parseAuthorLines(authorLines);
  }
}

/* ------------------------------------------------------------------ */
/* 结构：章节树 + 参考文献                                              */
/* ------------------------------------------------------------------ */

function buildSectionsAndRefs(
  paper: PaperContent,
  lines: Line[],
  bodySize: number,
  consumed: Set<Line>,
): void {
  const root: Section[] = [];
  const stack: Section[] = [];
  let current: Section | null = null;
  let paraLines: string[] = [];
  let prev: Line | null = null;

  // 参考文献收集状态
  let collectingRefs = false;
  const refLines: string[] = [];

  const flushPara = () => {
    if (paraLines.length > 0 && current) {
      const text = joinLines(paraLines).trim();
      if (text) current.paragraphs.push(text);
    }
    paraLines = [];
  };

  for (const line of lines) {
    if (consumed.has(line)) continue;
    const t = line.text.trim();
    if (!t) continue;

    const heading = detectHeading(line, bodySize);

    if (heading) {
      flushPara();
      // 进入参考文献区
      if (/^(references|bibliography|参考文献)\b/i.test(t)) {
        collectingRefs = true;
        current = null;
        prev = line;
        continue;
      }
      collectingRefs = false;
      const sec: Section = {
        level: heading.level,
        heading: t,
        paragraphs: [],
        formulaIds: [],
        children: [],
      };
      pushSection(root, stack, sec);
      current = sec;
      prev = line;
      continue;
    }

    if (collectingRefs) {
      refLines.push(t);
      prev = line;
      continue;
    }

    // 尚未遇到任何标题时，开一个"正文"前置节收纳内容
    if (!current) {
      current = { level: 1, heading: '正文', paragraphs: [], formulaIds: [], children: [] };
      root.push(current);
      stack.length = 0;
      stack.push(current);
    }

    if (prev && shouldStartParagraph(prev, line, bodySize)) flushPara();
    paraLines.push(t);
    prev = line;
  }
  flushPara();

  paper.sections = root.filter((s) => s.paragraphs.length > 0 || s.children.length > 0);
  paper.references = parseReferences(refLines);
  if (refLines.length > 0 && paper.references.length === 0) {
    paper.warnings.push('检测到参考文献区但未能拆分为条目。');
  }
}

/** 维护章节栈，按 level 把新节挂到正确的父节点 */
function pushSection(root: Section[], stack: Section[], sec: Section): void {
  while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) {
    stack.pop();
  }
  const parent = stack.length > 0 ? stack[stack.length - 1] : null;
  if (parent) parent.children.push(sec);
  else root.push(sec);
  stack.push(sec);
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 把多行拼成一段：行尾连字符去除，其余以空格连接 */
function joinLines(lines: string[]): string {
  return joinLayoutLines(lines);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 兜底分段：按较长的句号+空格粗切，避免整篇一大段 */
function splitIntoParagraphs(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  // 简单按 ~600 字上限滚动切分，保证 LLM 输入可控
  const sentences = t.split(/(?<=[.!?。！？])\s+/);
  const paras: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > 600) {
      if (cur) paras.push(cur.trim());
      cur = s;
    } else {
      cur += (cur ? ' ' : '') + s;
    }
  }
  if (cur.trim()) paras.push(cur.trim());
  return paras;
}

/** 估计正文字号：取出现频次最高的行字号（四舍五入到 0.5） */
function estimateBodySize(lines: Line[]): number {
  const count = new Map<number, number>();
  for (const l of lines) {
    const key = Math.round(l.size * 2) / 2;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  let best = 10;
  let bestN = -1;
  for (const [size, n] of count) {
    if (n > bestN) {
      best = size;
      bestN = n;
    }
  }
  return best || 10;
}
