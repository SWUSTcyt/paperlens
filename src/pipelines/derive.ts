// 公式推导流水线
// 目前是单发 single-shot；如公式所在章节过长，会按 token 预算截断。

import type { Formula, PaperContent, Section } from '../extractors/types';
import { buildDerivationPrompt } from '../prompts/derivation';
import { chatStream, type ChatStreamChunk } from '../bridge/llmBridge';
import { truncateByTokens } from '../util/tokenEstimate';

const CONTEXT_BUDGET_TOKENS = 1500;

export interface DeriveOptions {
  signal?: AbortSignal;
}

export async function* derivePipeline(
  paper: PaperContent,
  formula: Formula,
  opts: DeriveOptions = {},
): AsyncGenerator<ChatStreamChunk, void, void> {
  const context = truncateByTokens(
    findFormulaContext(paper, formula.id),
    CONTEXT_BUDGET_TOKENS,
  );
  const prompt = buildDerivationPrompt(paper, formula, { context });

  for await (const chunk of chatStream({
    task: 'derivation',
    signal: opts.signal,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  })) {
    yield chunk;
  }
}

/**
 * 在 paper 中查找目标公式所在章节，取前若干段作为上下文（段落文本中原本就带 $...$ 公式占位）。
 * 若找不到章节则回退到 formula.context（抽取期记录的 200 字短上下文）。
 */
export function findFormulaContext(paper: PaperContent, formulaId: number): string {
  const formula = paper.formulas.find((f) => f.id === formulaId);
  if (!formula) return '';

  const section = findSectionByFormulaId(paper.sections, formulaId);
  const parts: string[] = [];
  if (formula.sectionPath) {
    parts.push(`[章节路径：${formula.sectionPath}]`);
  }
  if (section && section.paragraphs.length > 0) {
    parts.push(section.paragraphs.slice(0, 4).join('\n\n'));
  } else if (formula.context) {
    parts.push(formula.context);
  }
  return parts.join('\n\n');
}

function findSectionByFormulaId(sections: Section[], formulaId: number): Section | null {
  for (const s of sections) {
    if (s.formulaIds.includes(formulaId)) return s;
    if (s.children.length) {
      const found = findSectionByFormulaId(s.children, formulaId);
      if (found) return found;
    }
  }
  return null;
}
