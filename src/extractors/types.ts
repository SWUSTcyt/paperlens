// PaperLens 抽取结果的通用类型定义
// 所有 extractors（abs / html / ar5iv）最终都要归一到 PaperContent 结构，
// 使得下游的 Summary / Derivation / Export 流水线对来源透明。

/** arXiv 页面类型 */
export type ArxivPageKind = 'abs' | 'html' | 'ar5iv';

/**
 * 论文来源大类：
 * - arxiv：来自 arXiv 网页（abs / html / ar5iv），公式为真实 LaTeX
 * - pdf：来自 PDF 字节解析（arXiv /pdf/ 或本地文件）
 * 缺省视为 'arxiv'，以保证既有代码零回归。
 */
export type PaperSource = 'arxiv' | 'pdf';

/**
 * 公式支持程度：
 * - latex：有真实 LaTeX 源（arXiv 网页）
 * - heuristic：由 PDF 启发式识别 + AI 还原（可能不准，实验性）
 * - none：不支持公式抽取（如 PDF MVP 阶段）
 * 缺省视为 'latex'。
 */
export type FormulaSupport = 'latex' | 'heuristic' | 'none';

/** 公式节点 */
export interface Formula {
  /** 扁平索引，1 起，便于在 Markdown 导出时形成 "公式 (1)" 这样的编号 */
  id: number;
  /** LaTeX 源 */
  latex: string;
  /** 是否为块级（true = $$...$$，false = $...$） */
  display: boolean;
  /** 所属章节标题，便于 LLM 理解语境 */
  sectionPath?: string;
  /** 公式上文若干字的自然语言（最多 200 字），供 LLM 理解 */
  context?: string;
  /** 原文 DOM id，用于回跳 */
  anchor?: string;
  /** 所在 PDF 页码（1 起）；网页来源为空。PDF 无法回跳 DOM，用页码代替定位 */
  page?: number;
  /** PDF 启发式识别的置信度 0–1；网页来源为空 */
  confidence?: number;
}

/** 章节（支持层级） */
export interface Section {
  /** 1 = h1 / section，2 = h2 / subsection，依此类推 */
  level: number;
  heading: string;
  /** 章节段落文本（不含公式节点的替代符号已被 $...$ 占位） */
  paragraphs: string[];
  /** 该章节内公式 id 列表（用于定位） */
  formulaIds: number[];
  /** 原文 DOM id，用于回跳 */
  anchor?: string;
  /** 子章节 */
  children: Section[];
}

/** 参考文献 */
export interface Reference {
  index: number;
  text: string;
}

/** 论文统一内容结构 */
export interface PaperContent {
  /** arXiv id，如 "2310.06825"；无法识别时为空字符串 */
  arxivId: string;
  /** 当前页 URL */
  url: string;
  /** 抽取来源 */
  kind: ArxivPageKind;
  /** 论文标题 */
  title: string;
  /** 作者列表 */
  authors: string[];
  /** 分类 / Subjects（如 cs.LG、math.OC），abs 页一般有 */
  categories: string[];
  /** 摘要纯文本 */
  abstract: string;
  /** 章节树 */
  sections: Section[];
  /** 扁平公式列表 */
  formulas: Formula[];
  /** 参考文献 */
  references: Reference[];
  /** 抽取时间戳 */
  extractedAt: number;
  /** 抽取过程中遇到的警告（如某些字段缺失） */
  warnings: string[];
  /** 来源大类；缺省视为 'arxiv' */
  source?: PaperSource;
  /** 公式支持程度；缺省视为 'latex' */
  formulaSupport?: FormulaSupport;
  /** PDF 页数；网页来源为空 */
  pageCount?: number;
}

/** 空白壳，方便 extractor 渐进填充 */
export function createEmptyPaper(
  kind: ArxivPageKind,
  url: string,
): PaperContent {
  return {
    arxivId: '',
    url,
    kind,
    title: '',
    authors: [],
    categories: [],
    abstract: '',
    sections: [],
    formulas: [],
    references: [],
    extractedAt: Date.now(),
    warnings: [],
  };
}

/** 从常见 arXiv URL / DOM 中推断 arxiv id */
export function parseArxivId(url: string, doc?: Document): string {
  try {
    const u = new URL(url);
    // /abs/2310.06825、/html/2310.06825v2、/pdf/2310.06825 等
    const match = u.pathname.match(/\/(abs|html|pdf)\/([^/]+?)(v\d+)?\/?$/);
    if (match) return match[2];
    // ar5iv /html/2310.06825
    const ar5 = u.pathname.match(/\/html\/([^/]+?)(v\d+)?\/?$/);
    if (ar5) return ar5[1];
  } catch {
    // ignore
  }
  // 兜底：从 meta 标签读
  const meta = doc?.querySelector('meta[name="citation_arxiv_id"]');
  return meta?.getAttribute('content')?.trim() ?? '';
}
