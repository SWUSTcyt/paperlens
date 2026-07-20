import type { Formula, FormulaSupport, Section } from '../extractors/types';
import type { LayoutLine } from './textLayout';

const MATH_FONT_PATTERN = /(?:cmmi|cmsy|cmex|msam|msbm|stix|math|symbol|eufm|eusm|rsfs)/i;
const MATH_SYMBOL_PATTERN = /[∑∫∏√≤≥≈≠∞∂∇±×÷∈∉⊂⊃⊆⊇∪∩→←↔⇒⇔α-ωΑ-Ω₀-₉⁰-⁹ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]/gu;
const OPERATOR_PATTERN = /[=<>+*\/^_{}\[\]|]|(?:\b(?:sin|cos|tan|log|exp|max|min|arg)\b)/i;
const EQUATION_NUMBER_PATTERN = /\(\s*\d+(?:\.\d+)*\s*\)\s*$/;

export interface PdfFormulaHeuristicResult {
  formulaSupport: FormulaSupport;
  formulas: Formula[];
  /** 仅用于评估与问题定位，不进入 PaperContent。 */
  diagnostics?: PdfFormulaCandidateDiagnostic[];
}

export interface PdfFormulaCandidateDiagnostic {
  formulaId: number;
  anchorLineIndex: number;
  sourceLineIndexes: number[];
  sourceLines: string[];
  confidence: number;
}

export type PdfHeadingDetector = (line: LayoutLine, bodySize: number) => { level: number } | null;

/** 判断 PDF 字体族是否明显属于数学字体。 */
export function isMathFontName(fontName: string): boolean {
  return MATH_FONT_PATTERN.test(fontName);
}

/**
 * 从已完成阅读顺序重建的 PDF 行中识别疑似公式。
 * `latex` 有意保留原始 PDF 文本，后续由 LLM 先还原再推导。
 */
export function detectPdfFormulaCandidates(
  lines: LayoutLine[],
  bodySize: number,
  headingDetector: PdfHeadingDetector = detectFormulaSectionHeading,
): PdfFormulaHeuristicResult {
  const eligible: ScoredFormulaLine[] = [];
  const sectionStack: string[] = [];
  let collectingReferences = false;

  lines.forEach((line, index) => {
    const text = line.text.trim();
    const heading = headingDetector(line, bodySize);
    if (heading) {
      collectingReferences = /^(references|bibliography|参考文献)\b/i.test(text);
      if (!collectingReferences) {
        sectionStack.length = Math.max(0, heading.level - 1);
        sectionStack[heading.level - 1] = text;
      }
      return;
    }
    if (collectingReferences || !text || isPageEdge(line)) return;

    const scoredLine = scoreFormulaLine(line);
    eligible.push({
      line,
      index,
      confidence: scoredLine?.confidence ?? 0,
      display: scoredLine?.display ?? false,
      sectionPath: sectionStack.filter(Boolean).join(' > ') || undefined,
    });
  });

  const blocks = buildFormulaBlocks(eligible, bodySize);

  // 单一弱信号不足以开启实验性能力；质量不够时保持 Phase A/B 的安全降级。
  if (blocks.length === 0 || Math.max(...blocks.map((candidate) => candidate.confidence)) < 0.65) {
    return { formulaSupport: 'none', formulas: [], diagnostics: [] };
  }

  const selectedBlocks = blocks.slice(0, 200);
  const candidateIndexes = new Set(selectedBlocks.flatMap((candidate) => candidate.lines.map((line) => line.index)));
  const formulas = selectedBlocks.map((candidate, formulaIndex): Formula => ({
    id: formulaIndex + 1,
    latex: assembleFormulaBlock(candidate.lines, candidate.anchor, bodySize),
    display: candidate.display,
    sectionPath: candidate.sectionPath,
    context: findNearbyContext(lines, candidate.anchor.index, candidateIndexes, bodySize, headingDetector),
    page: candidate.anchor.line.page,
    confidence: candidate.confidence,
  }));

  return {
    formulaSupport: 'heuristic',
    formulas,
    diagnostics: selectedBlocks.map((candidate, formulaIndex) => ({
      formulaId: formulaIndex + 1,
      anchorLineIndex: candidate.anchor.index,
      sourceLineIndexes: candidate.lines.map((line) => line.index),
      sourceLines: candidate.lines.map((line) => line.line.text),
      confidence: candidate.confidence,
    })),
  };
}

interface ScoredFormulaLine {
  line: LayoutLine;
  index: number;
  confidence: number;
  display: boolean;
  sectionPath?: string;
}

interface FormulaBlock {
  anchor: ScoredFormulaLine;
  lines: ScoredFormulaLine[];
  confidence: number;
  display: boolean;
  sectionPath?: string;
}

/** 先按二维邻近关系收拢公式碎片，再进入 0.6/0.65 门禁。 */
function buildFormulaBlocks(lines: ScoredFormulaLine[], bodySize: number): FormulaBlock[] {
  const anchors = lines.filter(
    (line) => line.confidence >= 0.6 || isEquationNumberAnchor(line),
  );
  const claimed = new Set<number>();
  const blocks: FormulaBlock[] = [];

  for (const anchor of anchors) {
    if (claimed.has(anchor.index)) continue;
    const blockLines = collectFormulaBlock(lines, anchor, bodySize)
      .sort((a, b) => a.index - b.index);
    const numberedAnchor = isEquationNumberAnchor(anchor);
    const numberedFormulaEvidence = numberedAnchor && blockLines.some((line) =>
      line.index !== anchor.index ? hasFormulaEvidence(line.line) :
        !/^\(\s*\d+(?:\.\d+)*\s*\)$/.test(line.line.text.trim()) && hasFormulaEvidence(line.line),
    );
    const confidence = Math.max(
      ...blockLines.map((line) => line.confidence),
      numberedFormulaEvidence ? 0.68 : 0,
    );
    if (confidence < 0.6) continue;

    blockLines.forEach((line) => claimed.add(line.index));
    blocks.push({
      anchor,
      lines: blockLines,
      confidence,
      display: numberedAnchor || blockLines.length > 1 || anchor.display,
      sectionPath: anchor.sectionPath,
    });
  }
  return blocks;
}

function collectFormulaBlock(
  lines: ScoredFormulaLine[],
  anchor: ScoredFormulaLine,
  bodySize: number,
): ScoredFormulaLine[] {
  const selected = new Map<number, ScoredFormulaLine>([[anchor.index, anchor]]);
  let changed = true;
  while (changed && selected.size < 8) {
    changed = false;
    for (const candidate of lines) {
      if (selected.has(candidate.index) || candidate.line.page !== anchor.line.page) continue;
      if (Math.abs(candidate.line.y - anchor.line.y) > bodySize * 3.2) continue;
      if (!isFormulaFragment(candidate)) continue;
      if (![...selected.values()].some((current) => canJoinFormulaLines(current.line, candidate.line, bodySize))) {
        continue;
      }
      selected.set(candidate.index, candidate);
      changed = true;
      if (selected.size >= 8) break;
    }
  }
  return [...selected.values()];
}

function isEquationNumberAnchor(candidate: ScoredFormulaLine): boolean {
  const text = candidate.line.text.trim();
  if (!EQUATION_NUMBER_PATTERN.test(text)) return false;
  const numberOnly = /^\(\s*\d+(?:\.\d+)*\s*\)$/.test(text);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const columnWidth = candidate.line.column === 0 ? candidate.line.pageWidth : candidate.line.pageWidth / 2;
  const compact = candidate.line.endX - candidate.line.x <= columnWidth * 0.95 && wordCount <= 10;
  const formulaEvidence = numberOnly || candidate.confidence > 0 || OPERATOR_PATTERN.test(text) ||
    (text.match(MATH_SYMBOL_PATTERN)?.length ?? 0) > 0;
  return compact && formulaEvidence;
}

function hasFormulaEvidence(line: LayoutLine): boolean {
  const text = line.text.trim();
  const mathFontRatio = Math.max(0, Math.min(1, line.mathFontRatio ?? (isMathFontName(line.font) ? 1 : 0)));
  return mathFontRatio >= 0.25 || (text.match(MATH_SYMBOL_PATTERN)?.length ?? 0) > 0 ||
    (text.match(new RegExp(OPERATOR_PATTERN.source, 'giu'))?.length ?? 0) > 0;
}

function isFormulaFragment(candidate: ScoredFormulaLine): boolean {
  const text = candidate.line.text.trim();
  if (!text || text.length > 160) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) return false;
  if (candidate.confidence > 0) return true;
  if ((text.match(MATH_SYMBOL_PATTERN)?.length ?? 0) > 0) return true;
  if (/^\(\s*\d+(?:\.\d+)*\s*\)$/.test(text)) return true;
  if (/[()[\]{}]/.test(text) && wordCount <= 4) return true;
  return /^(?:[A-Z]{1,8}|[a-z]{1,3}\d*|[α-ωΑ-Ω][A-Za-z0-9]*)$/.test(text);
}

function canJoinFormulaLines(a: LayoutLine, b: LayoutLine, bodySize: number): boolean {
  const verticalGap = Math.abs(a.y - b.y);
  if (verticalGap > bodySize * 1.4) return false;
  const horizontalGap = Math.max(a.x, b.x) - Math.min(a.endX, b.endX);
  if (a.column === b.column) return horizontalGap <= bodySize * 4;
  // pdf.js 可能把同一条通栏公式的左右片段误分到两栏；仅在同一视觉带且水平相接时关联。
  return verticalGap <= bodySize * 1.1 && horizontalGap <= bodySize * 1.5;
}

function assembleFormulaBlock(
  lines: ScoredFormulaLine[],
  anchor: ScoredFormulaLine,
  bodySize: number,
): string {
  const baseline = lines
    .filter((line) => Math.abs(line.line.y - anchor.line.y) <= Math.max(2, bodySize * 0.45))
    .sort((a, b) => a.line.x - b.line.x);
  const baselineIndexes = new Set(baseline.map((line) => line.index));
  const extra = lines
    .filter((line) => !baselineIndexes.has(line.index))
    .sort((a, b) => b.line.y - a.line.y || a.line.x - b.line.x);
  const rows = [joinSpatialLine(baseline, bodySize), ...extra.map((line) => line.line.text.trim())]
    .filter(Boolean);
  return [...new Set(rows)].join('\n');
}

function joinSpatialLine(lines: ScoredFormulaLine[], bodySize: number): string {
  let output = '';
  let previousEnd: number | null = null;
  for (const candidate of lines) {
    if (previousEnd !== null && candidate.line.x - previousEnd > bodySize * 0.25) output += ' ';
    output += candidate.line.text.trim();
    previousEnd = candidate.line.endX;
  }
  return output;
}

/** 把候选 ID 回填到对应章节；找不到章节的候选由 UI 归入“其他公式”。 */
export function assignFormulaIdsToSections(sections: Section[], formulas: Formula[]): void {
  const formulasByPath = new Map<string, number[]>();
  for (const formula of formulas) {
    if (!formula.sectionPath) continue;
    const ids = formulasByPath.get(formula.sectionPath) ?? [];
    ids.push(formula.id);
    formulasByPath.set(formula.sectionPath, ids);
  }

  const walk = (items: Section[], ancestors: string[]) => {
    for (const section of items) {
      const path = [...ancestors, section.heading].filter(Boolean);
      const ids = formulasByPath.get(path.join(' > ')) ?? [];
      section.formulaIds = [...new Set([...section.formulaIds, ...ids])];
      walk(section.children, path);
    }
  };
  walk(sections, []);
}

function scoreFormulaLine(line: LayoutLine): { confidence: number; display: boolean } | null {
  const text = line.text.trim();
  if (text.length < 3 || text.length > 240) return null;

  const mathFontRatio = Math.max(0, Math.min(1, line.mathFontRatio ?? (isMathFontName(line.font) ? 1 : 0)));
  const symbolCount = text.match(MATH_SYMBOL_PATTERN)?.length ?? 0;
  const operatorCount = text.match(new RegExp(OPERATOR_PATTERN.source, 'giu'))?.length ?? 0;
  const numbered = EQUATION_NUMBER_PATTERN.test(text);
  const width = Math.max(0, line.endX - line.x);
  const columnWidth = line.column === 0 ? line.pageWidth : line.pageWidth / 2;
  const columnCenter = line.column === 1
    ? line.pageWidth * 0.25
    : line.column === 2
      ? line.pageWidth * 0.75
      : line.pageWidth * 0.5;
  const centerOffset = Math.abs((line.x + line.endX) / 2 - columnCenter);
  const centeredShort = width <= columnWidth * (line.column === 0 ? 0.78 : 0.9) &&
    centerOffset <= columnWidth * 0.32;
  const centeredNumbered = centeredShort && numbered &&
    (mathFontRatio >= 0.25 || symbolCount > 0 || operatorCount > 0);

  let confidence = 0;
  if (mathFontRatio >= 0.75) confidence += 0.62;
  else if (mathFontRatio >= 0.45) confidence += 0.5;
  else if (mathFontRatio >= 0.25) confidence += 0.34;

  if (symbolCount >= 3) confidence += 0.55;
  else if (symbolCount === 2) confidence += 0.44;
  else if (symbolCount === 1) confidence += 0.2;

  if (centeredNumbered) confidence += 0.68;
  if (operatorCount > 0) confidence += 0.12;

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 12 && mathFontRatio < 0.45 && symbolCount < 3) confidence -= 0.35;
  if (/^[A-Za-z ]+[.!?:;]$/.test(text) && operatorCount === 0) confidence -= 0.35;

  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
  if (confidence === 0) return null;
  return {
    confidence,
    display: centeredNumbered || (centeredShort && (mathFontRatio >= 0.45 || symbolCount >= 2)),
  };
}

function findNearbyContext(
  lines: LayoutLine[],
  candidateIndex: number,
  candidateIndexes: Set<number>,
  bodySize: number,
  headingDetector: PdfHeadingDetector,
): string | undefined {
  const context: string[] = [];
  for (let index = candidateIndex - 1; index >= 0 && context.length < 2; index--) {
    const line = lines[index];
    if (line.page !== lines[candidateIndex].page || headingDetector(line, bodySize)) break;
    if (!candidateIndexes.has(index) && !isPageEdge(line) && line.text.trim()) context.unshift(line.text.trim());
  }
  for (let index = candidateIndex + 1; index < lines.length && context.length < 3; index++) {
    const line = lines[index];
    if (line.page !== lines[candidateIndex].page || headingDetector(line, bodySize)) break;
    if (!candidateIndexes.has(index) && !isPageEdge(line) && line.text.trim()) context.push(line.text.trim());
  }
  const joined = context.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, 200) : undefined;
}

function isPageEdge(line: LayoutLine): boolean {
  return line.y >= line.pageHeight * 0.9 || line.y <= line.pageHeight * 0.1;
}

/** 纯模块默认标题判定；生产抽取会注入 structure.ts 的完整判定器。 */
function detectFormulaSectionHeading(line: LayoutLine, bodySize: number): { level: number } | null {
  const text = line.text.trim();
  const numbered = text.match(/^(\d+(?:\.\d+)*)\.?\s+[A-Za-z].{0,80}$/);
  if (numbered) return { level: Math.min(numbered[1].split('.').length, 4) };
  if (line.size > bodySize * 1.15 && text.length < 70 && /^[A-Z]/.test(text)) return { level: 1 };
  return null;
}
