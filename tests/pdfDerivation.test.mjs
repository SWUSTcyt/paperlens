import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDerivationPrompt,
  buildDerivationUser,
} from '../src/prompts/derivation.ts';

const formula = {
  id: 4,
  latex: 'L(θ) = ∑ᵢ pᵢ log pᵢ (7)',
  display: true,
  sectionPath: '3 Method',
  page: 6,
  confidence: 0.74,
};

test('PDF heuristic prompt 明确先还原 LaTeX 并携带页码与置信度', () => {
  const prompt = buildDerivationPrompt(paper('heuristic'), formula, { context: 'objective context' });

  assert.equal(prompt.heuristic, true);
  assert.match(prompt.system, /先还原.*LaTeX/);
  assert.match(prompt.system, /不确定|歧义/);
  assert.match(prompt.user, /原始 PDF 公式文本/);
  assert.match(prompt.user, /第 6 页/);
  assert.match(prompt.user, /74%/);
  assert.match(prompt.user, /objective context/);
  assert.doesNotMatch(prompt.user, /```latex/);
});

test('网页 latex 路径保持现有 prompt，不混入 PDF 实验性指令', () => {
  const arxiv = paper('latex');
  const prompt = buildDerivationPrompt(arxiv, formula, { context: 'paper context' });

  assert.equal(prompt.heuristic, false);
  assert.equal(prompt.user, buildDerivationUser(arxiv, formula, { context: 'paper context' }));
  assert.match(prompt.user, /```latex/);
  assert.doesNotMatch(prompt.user, /原始 PDF 公式文本/);
  assert.doesNotMatch(prompt.system, /PDF 文本层/);
});

function paper(formulaSupport) {
  return {
    arxivId: '1234.5678',
    url: 'https://example.org/paper.pdf',
    kind: 'html',
    title: 'Example Paper',
    authors: [],
    categories: ['cs.LG'],
    abstract: '',
    sections: [],
    formulas: [formula],
    references: [],
    extractedAt: 0,
    warnings: [],
    source: formulaSupport === 'heuristic' ? 'pdf' : 'arxiv',
    formulaSupport,
  };
}
