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
  const paragraphs: string[] = [];

  // 段落：不再局限于直接子节点。
  // LaTeXML 会把正文包在 .ltx_para、列表 .ltx_itemize/.ltx_item、定理 .ltx_theorem 等容器里，
  // 早期只取 `:scope > p` 会整段丢失。这里在本节范围内收集所有段落节点，
  // 但遇到"子章节"边界就停止下探，避免把子章节的正文重复计入父节。
  const paraEls = collectWithinSection(sec, 'p, .ltx_p');
  for (const p of paraEls) {
    const text = renderTextWithFormulas(p, (raw) => {
      const id = addFormula(raw.latex, raw.display, raw.anchor, path.join(' > '), trimContext(p.textContent));
      formulaIds.push(id);
      return id;
    });
    if (text) paragraphs.push(text);
  }

  // 图/表说明文字（figcaption / .ltx_caption）也纳入正文，避免遗漏关键描述
  const captionEls = collectWithinSection(sec, 'figcaption, .ltx_caption');
  for (const cap of captionEls) {
    const text = renderTextWithFormulas(cap, (raw) => {
      const id = addFormula(raw.latex, raw.display, raw.anchor, path.join(' > '), trimContext(cap.textContent));
      formulaIds.push(id);
      return id;
    });
    if (text) paragraphs.push(text);
  }

  // 独立 display 公式（不在段落内的方程块，如 .ltx_equation / .ltx_equationgroup，
  // 或直接作为 section 子节点的 <math display="block">）。
  // 用 renderTextWithFormulas 已经写入的 data-pl-fid 做去重，避免与段落内公式重复计入。
  const looseMathNodes: Element[] = [];
  for (const eq of collectWithinSection(sec, '.ltx_equation, .ltx_equationgroup')) {
    looseMathNodes.push(...Array.from(eq.querySelectorAll('math')));
  }
  looseMathNodes.push(...Array.from(sec.querySelectorAll(':scope > math')));
  for (const m of looseMathNodes) {
    if ((m as HTMLElement).hasAttribute('data-pl-fid')) continue; // 已在段落内处理过，跳过
    const raw = extractLatexFromMathNode(m);
    if (!raw) continue;
    const id = addFormula(raw.latex, raw.display, raw.anchor, path.join(' > '), undefined);
    // 打标：既供"回跳原文"精确滚动，也用于本轮去重
    try {
      (m as HTMLElement).setAttribute('data-pl-fid', String(id));
    } catch {
      // 忽略：极少数节点不可写属性
    }
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

  const makeSection = (level: number, heading: string, anchor?: string): Section => ({
    level,
    heading,
    paragraphs: [],
    formulaIds: [],
    anchor,
    children: [],
  });

  for (const child of children) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      current = makeSection(
        tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3,
        normalize(child.textContent),
        child.id || undefined,
      );
      sections.push(current);
    } else {
      // 首个标题之前的正文不再丢弃：懒创建一个无标题的"前导段"来承接
      if (!current) {
        current = makeSection(1, '', undefined);
        sections.push(current);
      }
      const active = current;
      const text = renderTextWithFormulas(child, (raw) => {
        const id = addFormula(raw.latex, raw.display, raw.anchor, active.heading, trimContext(child.textContent));
        active.formulaIds.push(id);
        return id;
      });
      if (text) active.paragraphs.push(text);
    }
  }

  // 过滤掉完全空的前导段（既无标题也无正文与公式）
  return sections.filter(
    (s) => s.heading || s.paragraphs.length > 0 || s.formulaIds.length > 0,
  );
}

/** 判断元素是否是"子章节"边界：遍历正文时不应跨入，交由 parseSection 递归处理 */
function isSubsectionBoundary(el: Element): boolean {
  return el.matches('section, .ltx_subsection, .ltx_subsubsection, .ltx_paragraph');
}

/**
 * 在 section 内收集匹配 selector 的元素，但遇到子章节即停止下探，
 * 避免把子章节的正文/公式重复计入父节。
 */
function collectWithinSection(root: Element, selector: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (isSubsectionBoundary(child)) continue; // 子章节交由递归处理
      if (child.matches(selector)) out.push(child as HTMLElement);
      walk(child);
    }
  };
  walk(root);
  return out;
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
