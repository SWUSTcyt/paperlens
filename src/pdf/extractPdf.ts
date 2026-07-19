// PDF 字节 → PaperContent 抽取管线（MVP：文本 + 章节结构，暂不抽公式）
//
// 设计原则：
// 1. 归一到与 arXiv 抽取器一致的 PaperContent，使下游 Summary / Export 对来源透明。
// 2. 健壮性优先：任何一步失败都降级为"整篇纯文本"，并在 warnings 里如实告知，
//    保证「论文解读」在结构识别不理想时仍可用。
// 3. MVP 阶段 formulaSupport = 'none'，公式列表为空（公式识别是后续 Phase C）。
//
// 处理流程：每页取带坐标的文本片段 → 分栏 → 聚行 → 去页眉页脚 → 去连字符/分段
//          → 识别标题/摘要/章节/参考文献 → 组装 PaperContent。

import {
  createEmptyPaper,
  parseArxivId,
  type PaperContent,
  type Reference,
  type Section,
} from '../extractors/types';
import { loadPdfjs } from './loadPdfjs';

/** pdf.js 文本片段的最小结构（避免深引用其内部类型路径） */
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

/** 归一后的文本片段（页面坐标：原点左下，y 越大越靠上） */
interface RawItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
}

/** 一行文本（同一 y 附近的片段合并而成） */
interface Line {
  page: number;
  x: number;
  y: number;
  endX: number;
  size: number;
  font: string;
  text: string;
}

/**
 * 主入口：解析 PDF 字节，返回 PaperContent。
 * @param data PDF 原始字节
 * @param url  该 PDF 的地址（arXiv /pdf/ 链接或合成 key），用于缓存与 arxivId 推断
 */
export async function extractPdf(data: ArrayBuffer, url: string): Promise<PaperContent> {
  const paper = createEmptyPaper('html', url); // kind 占位；下方标注 source='pdf'
  paper.source = 'pdf';
  paper.formulaSupport = 'none';
  paper.arxivId = parseArxivId(url);

  const pdfjs = await loadPdfjs();
  // pdf.js 需要独占 buffer，复制一份避免 detached 问题
  const doc = await pdfjs.getDocument({ data: data.slice(0) }).promise;
  paper.pageCount = doc.numPages;

  // 1. 逐页抽取并重建行
  const allLines: Line[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = normalizeItems(content.items as unknown as PdfTextItem[]);
      if (items.length === 0) continue;
      const lines = buildPageLines(items, viewport.width, p);
      allLines.push(...lines);
    } catch (err) {
      paper.warnings.push(`第 ${p} 页解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (allLines.length === 0) {
    paper.warnings.push('未能从 PDF 提取到任何文本，可能是扫描版（无文本层）PDF。');
    return paper;
  }

  // 2. 去页眉页脚（跨页重复的短文本 / 纯页码）
  const bodyLines = stripHeadersFooters(allLines);

  // 3. 估计正文字号（用于标题判定与分段）
  const bodySize = estimateBodySize(bodyLines);

  // 4. 提取标题 / 作者 / 摘要（并记录已消费的行，避免重复进正文）
  const consumed = new Set<Line>();
  extractFrontMatter(paper, bodyLines, bodySize, consumed);

  // 5. 组装章节树 + 参考文献
  buildSectionsAndRefs(paper, bodyLines, bodySize, consumed);

  // 6. 兜底：若结构识别几乎为空，退化为整篇纯文本单节，保证解读可用
  if (paper.sections.length === 0 && !paper.abstract) {
    const text = joinLines(bodyLines.map((l) => l.text));
    paper.sections.push({
      level: 1,
      heading: '正文',
      paragraphs: splitIntoParagraphs(text),
      formulaIds: [],
      children: [],
    });
    paper.warnings.push('未能识别章节结构，已退化为整篇纯文本（解读仍可用，但结构可能不准）。');
  }

  return paper;
}

/* ------------------------------------------------------------------ */
/* 版面重建                                                            */
/* ------------------------------------------------------------------ */

/** 归一 pdf.js 文本片段：过滤空串，换算坐标与字号 */
function normalizeItems(items: PdfTextItem[]): RawItem[] {
  const out: RawItem[] = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || it.str.trim() === '') continue;
    const t = it.transform || [];
    const x = t[4] ?? 0;
    const y = t[5] ?? 0;
    // 字号优先用 height；缺失时由变换矩阵推导
    const size = it.height && it.height > 0 ? it.height : Math.hypot(t[1] ?? 0, t[3] ?? 0) || 10;
    out.push({ str: it.str, x, y, w: it.width ?? 0, size, font: it.fontName ?? '' });
  }
  return out;
}

/**
 * 把一页的文本片段重建为有序的行：
 * - 先做分栏（双栏论文很常见）；
 * - 各栏内按 y 聚行、按 x 拼接；
 * - 输出顺序为「左栏自上而下 → 右栏自上而下」。
 */
function buildPageLines(items: RawItem[], pageWidth: number, page: number): Line[] {
  const columns = detectColumns(items, pageWidth);
  const lines: Line[] = [];
  for (const col of columns) {
    lines.push(...groupIntoLines(col, page));
  }
  return lines;
}

/** 分栏检测：返回按阅读顺序排列的若干栏（单栏时返回一个数组） */
function detectColumns(items: RawItem[], pageWidth: number): RawItem[][] {
  if (items.length < 10) return [items];
  const mid = pageWidth / 2;
  let left = 0;
  let right = 0;
  let cross = 0;
  for (const it of items) {
    const center = it.x + it.w / 2;
    const crosses = it.x < mid - pageWidth * 0.05 && it.x + it.w > mid + pageWidth * 0.05;
    if (crosses) cross++;
    else if (center < mid) left++;
    else right++;
  }
  const total = items.length;
  // 双栏判据：左右两侧都有足量内容，且横跨中缝的片段很少
  const twoCol = left > total * 0.2 && right > total * 0.2 && cross < total * 0.15;
  if (!twoCol) return [items];
  const leftItems = items.filter((it) => it.x + it.w / 2 < mid);
  const rightItems = items.filter((it) => it.x + it.w / 2 >= mid);
  return [leftItems, rightItems];
}

/** 同一栏内：按 y 自上而下聚类为行，行内按 x 拼接 */
function groupIntoLines(items: RawItem[], page: number): Line[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: RawItem[][] = [];
  let cur: RawItem[] = [];
  let curY = sorted[0].y;
  for (const it of sorted) {
    const tol = Math.max(2, it.size * 0.5);
    if (cur.length > 0 && Math.abs(it.y - curY) > tol) {
      groups.push(cur);
      cur = [];
    }
    if (cur.length === 0) curY = it.y;
    cur.push(it);
  }
  if (cur.length > 0) groups.push(cur);
  return groups.map((g) => assembleLine(g, page));
}

/** 把一组同行片段拼成一行文本（按 x 排序，间距大处补空格） */
function assembleLine(group: RawItem[], page: number): Line {
  group.sort((a, b) => a.x - b.x);
  let text = '';
  let prevEnd: number | null = null;
  for (const it of group) {
    if (prevEnd !== null) {
      const gap = it.x - prevEnd;
      if (gap > it.size * 0.25) text += ' ';
    }
    text += it.str;
    prevEnd = it.x + it.w;
  }
  const x = group[0].x;
  const endX = Math.max(...group.map((i) => i.x + i.w));
  const size = median(group.map((i) => i.size));
  const font = mostCommon(group.map((i) => i.font));
  return {
    page,
    x,
    y: group[0].y,
    endX,
    size,
    font,
    text: text.replace(/\s+/g, ' ').trim(),
  };
}

/* ------------------------------------------------------------------ */
/* 清洗：页眉页脚                                                       */
/* ------------------------------------------------------------------ */

/** 去除跨页重复的页眉/页脚与纯页码行 */
function stripHeadersFooters(lines: Line[]): Line[] {
  // 统计每页顶部/底部行的文本频次
  const byPage = new Map<number, Line[]>();
  for (const l of lines) {
    const arr = byPage.get(l.page) ?? [];
    arr.push(l);
    byPage.set(l.page, arr);
  }
  const edgeText = new Map<string, number>();
  for (const arr of byPage.values()) {
    if (arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => b.y - a.y);
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];
    for (const e of [top, bottom]) {
      const key = e.text.trim().toLowerCase();
      if (key) edgeText.set(key, (edgeText.get(key) ?? 0) + 1);
    }
  }
  const pageCount = byPage.size || 1;
  const repeatThreshold = Math.max(3, Math.ceil(pageCount * 0.3));

  return lines.filter((l) => {
    const t = l.text.trim();
    if (!t) return false;
    if (/^\d{1,4}$/.test(t)) return false; // 纯页码
    if (/^arxiv:\s*\d/i.test(t)) return false; // arXiv 水印
    const key = t.toLowerCase();
    // 跨多页重复出现的短文本 → 视为页眉/页脚
    if (t.length <= 80 && (edgeText.get(key) ?? 0) >= repeatThreshold) return false;
    return true;
  });
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
      if (/^(1\b|1\.|i\.|introduction\b)/i.test(t) || isHeading(l, bodySize)) break;
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
    // 取紧接标题下方的 1–2 行作为作者候选
    const authorLine = between.sort((a, b) => b.y - a.y)[0];
    if (authorLine && authorLine.text.length < 200 && !/^abstract\b/i.test(authorLine.text)) {
      paper.authors = authorLine.text
        .split(/,|;|、|·|\band\b/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 60);
    }
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

    const heading = isHeading(line, bodySize);

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

    // 分段：同页内纵向间距明显增大视为段落边界
    if (prev && prev.page === line.page) {
      const gap = prev.y - line.y;
      if (gap > bodySize * 1.8) flushPara();
    }
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

/** 判定一行是否为章节标题；返回层级或 null */
function isHeading(line: Line, bodySize: number): { level: number } | null {
  const t = line.text.trim();
  if (!t) return null;

  // 编号标题："1 Introduction"、"2.1 Method"、"3.2.1 ..."
  const m = t.match(/^(\d+(?:\.\d+)*)\.?\s+([A-Za-z].{0,80})$/);
  if (m && t.length < 90) {
    return { level: Math.min(m[1].split('.').length, 4) };
  }

  // 常见无编号章节词（较短且独占一行）
  if (
    t.length < 40 &&
    /^(abstract|introduction|related work|background|preliminaries|method(s|ology)?|approach|model|experiments?|evaluation|results?|analysis|discussion|conclusions?|limitations?|references|bibliography|acknowledge?ments?|appendix|参考文献)\b/i.test(
      t,
    )
  ) {
    return { level: 1 };
  }

  // 字号显著大于正文、较短、首字母大写、不以标点结尾
  if (line.size > bodySize * 1.15 && t.length < 60 && /^[A-Z]/.test(t) && !/[.;:,]$/.test(t)) {
    return { level: 1 };
  }
  return null;
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

/** 把参考文献区文本拆成条目：优先按 [n] / n. 起始切分 */
function parseReferences(refLines: string[]): Reference[] {
  if (refLines.length === 0) return [];
  const refs: Reference[] = [];
  let buf = '';
  let index = 0;

  const flush = () => {
    const text = buf.replace(/\s+/g, ' ').trim();
    if (text) refs.push({ index: refs.length + 1, text });
    buf = '';
  };

  for (const raw of refLines) {
    const line = raw.trim();
    const marker = line.match(/^\[(\d+)\]\s*/) || line.match(/^(\d{1,3})\.\s+/);
    if (marker) {
      flush();
      index = Number(marker[1]);
      buf = line.replace(/^\[\d+\]\s*/, '').replace(/^\d{1,3}\.\s+/, '');
    } else {
      // 连字符续行处理
      if (/-$/.test(buf) && /^[a-z]/.test(line)) buf = buf.slice(0, -1) + line;
      else buf += (buf ? ' ' : '') + line;
    }
  }
  flush();
  // 保留识别到的原始编号（若有）
  if (index > 0 && refs.length > 0) {
    // 不强制对齐，index 字段仅作展示序号
  }
  return refs;
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 把多行拼成一段：行尾连字符去除，其余以空格连接 */
function joinLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    if (!out) {
      out = s;
      continue;
    }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(s)) {
      out = out.slice(0, -1) + s; // 去连字符合并
    } else {
      out += ' ' + s;
    }
  }
  return out;
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

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mostCommon(vals: string[]): string {
  const count = new Map<string, number>();
  for (const v of vals) count.set(v, (count.get(v) ?? 0) + 1);
  let best = '';
  let bestN = -1;
  for (const [v, n] of count) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
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
