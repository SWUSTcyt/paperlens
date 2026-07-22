import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMarkdown } from '../src/export/markdown.ts';

test('PDF heuristic 公式按原始文本导出，不伪装成有效 LaTeX', () => {
  const markdown = buildMarkdown({
    paper: paper('heuristic'),
    summary: null,
    derivations: {},
  });

  assert.match(markdown, /AI 识别，实验性/);
  assert.match(markdown, /第 4 页 · 置信度 72%/);
  assert.match(markdown, /```text\n\) = softmax\( \/ \)V \(1\)\n```/);
  assert.doesNotMatch(markdown, /\$\$\n\) = softmax/);
});

test('网页真 LaTeX 公式继续使用数学块导出', () => {
  const markdown = buildMarkdown({
    paper: paper('latex'),
    summary: null,
    derivations: {},
  });

  assert.match(markdown, /\$\$\n\) = softmax\( \/ \)V \(1\)\n\$\$/);
  assert.doesNotMatch(markdown, /AI 识别，实验性/);
});

test('MinerU OCR 可用数学块导出但明确不是作者 TeX 源码', () => {
  const ocrPaper = paper('ocr');
  ocrPaper.formulas[0].recognitionSource = 'mineru-ocr';
  ocrPaper.formulas[0].bbox = [100, 200, 300, 400];
  const markdown = buildMarkdown({ paper: ocrPaper, summary: null, derivations: {} });

  assert.match(markdown, /MinerU 本地 OCR/);
  assert.match(markdown, /不是作者 TeX 源码/);
  assert.match(markdown, /MinerU OCR · 第 4 页 · bbox 100,200,300,400/);
  assert.match(markdown, /\$\$\n\) = softmax\( \/ \)V \(1\)\n\$\$/);
  assert.doesNotMatch(markdown, /置信度 72%/);
});

function paper(formulaSupport) {
  return {
    arxivId: '',
    url: 'https://example.org/paper.pdf',
    kind: 'html',
    title: 'Example',
    authors: [],
    categories: [],
    abstract: '',
    sections: [],
    formulas: [{
      id: 1,
      latex: ') = softmax( / )V (1)',
      display: true,
      page: 4,
      confidence: 0.72,
    }],
    references: [],
    extractedAt: 0,
    warnings: [],
    source: formulaSupport === 'latex' ? 'arxiv' : 'pdf',
    formulaSupport,
  };
}
