import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adaptMineruDocument,
  buildMineruPredictionSet,
  stripDisplayDelimiters,
} from './helpers/mineruPoc.mjs';

const paper = { id: '1706.03762', title: 'Attention Is All You Need', pages: 15 };

test('pipeline content_list 提取展示公式并保持 0-1000 坐标', () => {
  const result = adaptMineruDocument({
    paper,
    backend: 'pipeline',
    contentList: [{
      type: 'equation',
      page_idx: 3,
      bbox: [344, 578, 840, 629],
      text: '$$\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}(QK^T/\\sqrt{d_k})V$$',
      img_path: 'images/equation.jpg',
    }],
    middle: {
      pdf_info: [{ para_blocks: [] }, { para_blocks: [{
        lines: [{ spans: [{ type: 'inline_equation', content: 'x+y' }] }],
      }] }],
    },
  });

  assert.equal(result.formulas.length, 1);
  assert.equal(result.formulas[0].page, 4);
  assert.deepEqual(result.formulas[0].bbox, [344, 578, 840, 629]);
  assert.equal(result.formulas[0].latex, String.raw`\mathrm{Attention}(Q,K,V)=\mathrm{softmax}(QK^T/\sqrt{d_k})V`);
  assert.equal(result.formulas[0].cropPath, 'images/equation.jpg');
  assert.equal(result.inlineFormulaCount, 1);
});

test('content_list_v2 与 VLM 归一到同一公式契约', () => {
  const v2 = adaptMineruDocument({
    paper,
    backend: 'hybrid-engine',
    contentList: [[{
      type: 'equation_interline',
      bbox: [100, 200, 900, 300],
      content: { math_content: String.raw`\frac{a}{b}`, math_type: 'latex' },
    }]],
  });
  assert.equal(v2.formulas[0].page, 1);
  assert.equal(v2.formulas[0].latex, String.raw`\frac{a}{b}`);

  const vlm = adaptMineruDocument({
    paper,
    backend: 'vlm-engine',
    contentList: [[{
      type: 'equation',
      bbox: [0.1, 0.2, 0.9, 0.3],
      content: String.raw`\sum_i x_i`,
    }]],
  });
  assert.deepEqual(vlm.formulas[0].bbox, [100, 200, 900, 300]);
});

test('空公式文档保持 completed，损坏内容记录为警告而不伪造候选', () => {
  const result = adaptMineruDocument({
    paper,
    backend: 'pipeline',
    contentList: [
      { type: 'text', page_idx: 0, bbox: [0, 0, 1000, 1000], text: '正文' },
      { type: 'equation', page_idx: 99, bbox: [2, 2, 1, 1], text: '$$x$$' },
      { type: 'equation', page_idx: 0, bbox: [1, 1, 2, 2], text: '' },
    ],
  });
  assert.deepEqual(result.formulas, []);
  assert.equal(result.warnings.length, 2);
});

test('预测集合固定 PDF-only 模式并保留文档失败', () => {
  const predictions = buildMineruPredictionSet({
    version: '3.4.4',
    backend: 'pipeline',
    environment: { summary: 'Windows CPU' },
    documents: [{ paperId: paper.id, status: 'completed', durationMs: 1234, formulas: [] }],
    failures: [{ paperId: '1810.04805', error: 'engine crashed', durationMs: 50 }],
  });
  assert.equal(predictions.engine, 'mineru-3.4.4/pipeline');
  assert.equal(predictions.evaluationMode.texSourceShortcut, false);
  assert.equal(predictions.evaluationMode.inlineFormulaPolicy, 'count-only');
  assert.equal(predictions.papers[1].status, 'failed');
});

test('非数组内容属于协议错误；公式分隔符只剥离外层', () => {
  assert.throws(() => adaptMineruDocument({ paper, backend: 'pipeline', contentList: {} }), /数组/);
  assert.equal(stripDisplayDelimiters('$$ x + $y$ $$'), 'x + $y$');
  assert.equal(stripDisplayDelimiters(String.raw`\[x+y\]`), 'x+y');
});
