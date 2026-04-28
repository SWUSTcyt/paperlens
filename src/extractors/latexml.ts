// arXiv /html/ 与 ar5iv 都是 LaTeXML 生成的 HTML，结构极其相似：
//   - <article class="ltx_document">
//   - <h1 class="ltx_title_document"> 论文标题
//   - <span class="ltx_personname">   作者
//   - <div class="ltx_abstract">      摘要
//   - <section class="ltx_section">   一级章节（带 id / class ltx_section）
//       <h2 class="ltx_title_section"> 章节标题
//       <section class="ltx_subsection"> 二级...
//   - <math alttext="...">            公式（alttext 为 LaTeX）
//   - <section class="ltx_bibliography"> 参考文献区
//       <li class="ltx_bibitem">        单条文献

import {
  createEmptyPaper,
  parseArxivId,
  type PaperContent,
  type Section,
  type Reference,
  type Formula,
} from './types';
import { extractLatexFromMathNode, renderTextWithFormulas } from '../formula/extract';

export function extractFromLatexml(
  doc: Document,
  url: string,
  kind: 'html' | 'ar5iv',
): PaperContent {
  const paper = createEmptyPaper(kind, url);
  paper.arxivId = parseArxivId(url, doc);

  const article = doc.querySelector('article.ltx_document') || doc.body;

  // 标题
  const titleEl = article.querySelector('h1.ltx_title_document, h1.ltx_title');
  paper.title = normalize(titleEl?.textContent);
  if (!paper.title) paper.warnings.push('未能抽取文档标题');

  // 作者：ltx_personname 可能有多个
  const authorEls = article.querySelectorAll('.ltx_personname');
  paper.authors = Array.from(authorEls)
    .map((el) => normalize(el.textContent))
    .filter(Boolean);

  // 摘要
  const absBlock = article.querySelector('.ltx_abstract');
  if (absBlock) {
    // 摘要内部可能有 <h6 class="ltx_title_abstract">Abstract</h6> + <p>...
    const paras = Array.from(absBlock.querySelectorAll('p')) as HTMLElement[];
    paper.abstract = paras
      .map((p) => normalize(p.textContent))
      .filter(Boolean)
      .join('\n');
    if (!paper.abstract) {
      paper.abstract = normalize(absBlock.textContent).replace(/^Abstract\s*/i, '');
    }
  }
  if (!paper.abstract) paper.warnings.push('未能抽取摘要');

  // 分类：LaTeXML 一般不含 arXiv 的 Subjects，留空
  paper.categories = [];

  // 扁平公式列表 + 章节树
  const formulas: Formula[] = [];
  let formulaCounter = 0;
  const addFormula = (latex: string, display: boolean, anchor?: string, sectionPath?: string, context?: string): number => {
    formulaCounter += 1;
    formulas.push({
      id: formulaCounter,
      latex,
      display,
      anchor,
      sectionPath,
      context,
    });
    return formulaCounter;
  };

  // 先抽章节
  const topSections = Array.from(
    article.querySelectorAll(':scope > section.ltx_section, :scope > div.ltx_section'),
  ) as HTMLElement[];

  paper.sections = topSections.map((sec) =>
    parseSection(sec, 1, [], addFormula),
  );

  // 如果 LaTeXML 没用 <section>，fallback 按 h2/h3 粗切
  if (paper.sections.length === 0) {
    paper.sections = parseFallbackByHeadings(article, addFormula);
  }

  paper.formulas = formulas;
  if (formulas.length === 0) paper.warnings.push('未抽到任何公式（可能该论文不含 <math> 标签）');

  // 参考文献
  const bibList = article.querySelectorAll('.ltx_bibitem');
  paper.references = Array.from(bibList).map<Reference>((li, i) => ({
    index: i + 1,
    text: normalize(li.textContent),
  }));

  return paper;
}

/** 递归解析章节（含嵌套） */
function parseSection(
  sec: Element,
  level: number,
  pathSoFar: string[],
  addFormula: (
    latex: string,
    display: boolean,
    anchor?: string,
    sectionPath?: string,
    context?: string,
  ) => number,
): Section {
  const headingEl = sec.querySelector(
    ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6',
  );
  const heading = normalize(headingEl?.textContent);
  const path = heading ? [...pathSoFar, heading] : pathSoFar;
  const anchor = sec.id || undefined;

  const formulaIds: number[] = [];

  // 段落：<p class="ltx_p"> 或直接 <p>
  const paraEls = Array.from(
    sec.querySelectorAll(':scope > p, :scope > .ltx_para > p'),
  ) as HTMLElement[];
  const paragraphs: string[] = [];
  for (const p of paraEls) {
    const text = renderTextWithFormulas(p, (raw) => {
      const id = addFormula(raw.latex, raw.display, raw.anchor, path.join(' > '), trimContext(p.textContent));
      formulaIds.push(id);
      return id;
    });
    if (text) paragraphs.push(text);
  }

  // 独立 display 公式可能在段落外（如 <math display="block"> 直接是 section 子节点）
  const looseMath = Array.from(
    sec.querySelectorAll(':scope > math, :scope > .ltx_equation math, :scope > .ltx_equationgroup math'),
  );
  for (const m of looseMath) {
    const raw = extractLatexFromMathNode(m);
    if (!raw) continue;
    const id = addFormula(raw.latex, raw.display, raw.anchor, path.join(' > '), undefined);
    formulaIds.push(id);
  }

  // 子章节：ltx_subsection / ltx_subsubsection
  const childSecs = Array.from(
    sec.querySelectorAll(
      ':scope > section, :scope > .ltx_subsection, :scope > .ltx_subsubsection',
    ),
  ) as HTMLElement[];
  const children: Section[] = childSecs.map((c) =>
    parseSection(c, level + 1, path, addFormula),
  );

  return {
    level,
    heading,
    paragraphs,
    formulaIds,
    anchor,
    children,
  };
}

/** 无 <section> 结构时的回退：按 h2/h3 分段 */
function parseFallbackByHeadings(
  article: Element,
  addFormula: (
    latex: string,
    display: boolean,
    anchor?: string,
    sectionPath?: string,
    context?: string,
  ) => number,
): Section[] {
  const sections: Section[] = [];
  const children = Array.from(article.children) as HTMLElement[];
  let current: Section | null = null;

  for (const child of children) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      current = {
        level: tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3,
        heading: normalize(child.textContent),
        paragraphs: [],
        formulaIds: [],
        anchor: child.id || undefined,
        children: [],
      };
      sections.push(current);
    } else if (current) {
      const text = renderTextWithFormulas(child, (raw) => {
        const id = addFormula(raw.latex, raw.display, raw.anchor, current?.heading ?? '', trimContext(child.textContent));
        current!.formulaIds.push(id);
        return id;
      });
      if (text) current.paragraphs.push(text);
    }
  }

  return sections;
}

function normalize(text?: string | null): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function trimContext(text?: string | null, maxLen = 200): string | undefined {
  const t = normalize(text);
  if (!t) return undefined;
  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
}
