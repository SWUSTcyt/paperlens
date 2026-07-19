import type { Formula, FormulaSupport, Section } from '../extractors/types';
import type { LayoutLine } from './textLayout';

const MATH_FONT_PATTERN = /(?:cmmi|cmsy|cmex|msam|msbm|stix|math|symbol|eufm|eusm|rsfs)/i;
const MATH_SYMBOL_PATTERN = /[∑∫∏√≤≥≈≠∞∂∇±×÷∈∉⊂⊃⊆⊇∪∩→←↔⇒⇔α-ωΑ-Ω₀-₉⁰-⁹ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]/gu;
const OPERATOR_PATTERN = /[=<>+*\/^_{}\[\]|]|(?:\b(?:sin|cos|tan|log|exp|max|min|arg)\b)/i;
const EQUATION_NUMBER_PATTERN = /\(\s*\d+(?:\.\d+)*\s*\)\s*$/;

export interface PdfFormulaHeuristicResult {
  formulaSupport: FormulaSupport;
  formulas: Formula[];
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
  const scored: Array<{ line: LayoutLine; index: number; confidence: number; display: boolean; sectionPath?: string }> = [];
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
    if (!scoredLine || scoredLine.confidence < 0.6) return;
    scored.push({
      line,
      index,
      confidence: scoredLine.confidence,
      display: scoredLine.display,
      sectionPath: sectionStack.filter(Boolean).join(' > ') || undefined,
    });
  });

  // 单一弱信号不足以开启实验性能力；质量不够时保持 Phase A/B 的安全降级。
  if (scored.length === 0 || Math.max(...scored.map((candidate) => candidate.confidence)) < 0.65) {
    return { formulaSupport: 'none', formulas: [] };
  }

  const candidateIndexes = new Set(scored.map((candidate) => candidate.index));
  const formulas = scored.slice(0, 200).map((candidate, formulaIndex): Formula => ({
    id: formulaIndex + 1,
    latex: candidate.line.text.trim(),
    display: candidate.display,
    sectionPath: candidate.sectionPath,
    context: findNearbyContext(lines, candidate.index, candidateIndexes, bodySize, headingDetector),
    page: candidate.line.page,
    confidence: candidate.confidence,
  }));

  return { formulaSupport: 'heuristic', formulas };
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
  const centerOffset = Math.abs((line.x + line.endX) / 2 - line.pageWidth / 2);
  const centeredShort = width <= line.pageWidth * 0.78 && centerOffset <= line.pageWidth * 0.16;
  const centeredNumbered = centeredShort && numbered;

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
