import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertValidGoldDataset,
  buildMarkdownReport,
  evaluateOcrPredictions,
  normalizeLatex,
  validateGoldDataset,
} from './helpers/pdfOcrPoc.mjs';

const corpus = {
  schemaVersion: 1,
  evaluationMode: mode(),
  papers: [{ id: '1706.03762', title: 'Attention', pages: 15 }],
};
const gold = {
  schemaVersion: 1,
  coordinateSystem: 'top-left-0-1000',
  evaluationMode: mode(),
  formulas: [
    {
      id: 'attention-eq-1',
      paperId: '1706.03762',
      page: 4,
      bbox: [350, 580, 840, 640],
      latex: String.raw`\operatorname{Attention}(Q,K,V)=\operatorname{softmax}(QK^T/\sqrt{d_k})V`,
      display: true,
      category: 'fraction',
      equationNumber: '1',
      core: true,
    },
  ],
};

test('仓库 POC 金标满足 13 篇与至少 65 条的冻结要求', async () => {
  const realCorpus = JSON.parse(await readFile(new URL('./fixtures/pdf-ocr-corpus.json', import.meta.url)));
  const realGold = JSON.parse(await readFile(new URL('./fixtures/pdf-ocr-gold.json', import.meta.url)));
  assert.equal(realCorpus.papers.length, 13);
  assertValidGoldDataset(realCorpus, realGold, { minimumFormulas: 65 });
});

test('金标校验拒绝 TeX 捷径、重复 ID 与越界 bbox', () => {
  const invalid = structuredClone(gold);
  invalid.evaluationMode.texSourceShortcut = true;
  invalid.formulas.push({ ...invalid.formulas[0], bbox: [0, 0, 1200, 10] });
  const errors = validateGoldDataset(corpus, invalid);
  assert.ok(errors.some((error) => error.includes('texSourceShortcut')));
  assert.ok(errors.some((error) => error.includes('id 重复')));
  assert.ok(errors.some((error) => error.includes('bbox')));
});

test('完整预测经人工审核后通过 P1，LaTeX 空白差异不影响精确代理', () => {
  const predictions = predictionSet({
    formulas: [{
      id: 'prediction-1',
      paperId: '1706.03762',
      page: 4,
      bbox: [360, 585, 830, 635],
      latex: String.raw`\operatorname{Attention}(Q, K, V) = \operatorname{softmax}(QK^T / \sqrt{d_k})V`,
      display: true,
      katexRenderable: true,
    }],
  });
  const reviews = {
    assessments: [{
      goldId: 'attention-eq-1',
      predictionId: 'prediction-1',
      structureCorrect: true,
      cropComplete: true,
    }],
    predictionAssessments: [{
      predictionId: 'prediction-1',
      validDisplayFormula: true,
    }],
  };
  const result = evaluateOcrPredictions(corpus, gold, predictions, reviews);
  assert.equal(result.metrics.detectionRecall, 1);
  assert.equal(result.metrics.exactLatexRate, 1);
  assert.equal(result.gate.status, 'pass');
  assert.match(buildMarkdownReport(result, predictions), /TeX 源捷径：关闭/);
});

test('抽样金标下由全部候选人工有效性审核计算精确率', () => {
  const predictions = predictionSet({
    formulas: [
      {
        id: 'prediction-1',
        paperId: '1706.03762',
        page: 4,
        bbox: [360, 585, 830, 635],
        latex: 'x=y',
        display: true,
        katexRenderable: true,
      },
      {
        id: 'prediction-2',
        paperId: '1706.03762',
        page: 5,
        bbox: [100, 200, 500, 250],
        latex: 'not-a-real-equation',
        display: true,
        katexRenderable: true,
      },
    ],
  });
  const pending = evaluateOcrPredictions(corpus, gold, predictions, {
    assessments: [],
    predictionAssessments: [{ predictionId: 'prediction-1', validDisplayFormula: true }],
  });
  assert.equal(pending.metrics.detectionPrecision, null);
  assert.equal(pending.gate.status, 'pending');

  const complete = evaluateOcrPredictions(corpus, gold, predictions, {
    assessments: [],
    predictionAssessments: [
      { predictionId: 'prediction-1', validDisplayFormula: true },
      { predictionId: 'prediction-2', validDisplayFormula: false },
    ],
  });
  assert.equal(complete.metrics.detectionPrecision, 0.5);
  assert.equal(complete.metrics.katexRenderableRate, 1);
});

test('缺少人工完整度审核时门禁保持 pending，不用 KaTeX 冒充正确', () => {
  const predictions = predictionSet({
    formulas: [{
      id: 'prediction-1',
      paperId: '1706.03762',
      page: 4,
      bbox: [360, 585, 830, 635],
      latex: 'x=y',
      display: true,
      katexRenderable: true,
    }],
  });
  const result = evaluateOcrPredictions(corpus, gold, predictions);
  assert.equal(result.metrics.katexRenderableRate, 1);
  assert.equal(result.metrics.structureCorrectRate, null);
  assert.equal(result.gate.status, 'pending');

  const templateResult = evaluateOcrPredictions(corpus, gold, predictions, {
    assessments: [{
      goldId: 'attention-eq-1',
      predictionId: 'prediction-1',
      structureCorrect: null,
      cropComplete: null,
    }],
    predictionAssessments: [{ predictionId: 'prediction-1', validDisplayFormula: null }],
  });
  assert.equal(templateResult.metrics.reviewedMatchCount, 0);
  assert.equal(templateResult.metrics.reviewedPredictionCount, 0);
  assert.equal(templateResult.gate.status, 'pending');
});

test('空预测不会崩溃，未命中项直接计为结构与裁剪失败', () => {
  const result = evaluateOcrPredictions(corpus, gold, predictionSet({ formulas: [] }), {
    assessments: [],
  });
  assert.equal(result.metrics.detectionRecall, 0);
  assert.equal(result.metrics.detectionPrecision, 0);
  assert.equal(result.metrics.structureCorrectRate, 0);
  assert.equal(result.metrics.cropCompleteRate, 0);
  assert.equal(result.unmatchedGold.length, 1);
  assert.equal(result.gate.status, 'fail');
});

test('抽样金标部分未召回时，已匹配项审核完即可裁决且未召回按失败计分', () => {
  const partialGold = structuredClone(gold);
  partialGold.formulas.push({
    ...partialGold.formulas[0],
    id: 'attention-eq-2',
    page: 5,
    bbox: [350, 700, 840, 750],
    core: false,
  });
  const predictions = predictionSet({
    formulas: [{
      id: 'prediction-1',
      paperId: '1706.03762',
      page: 4,
      bbox: [360, 585, 830, 635],
      latex: 'x=y',
      display: true,
      katexRenderable: true,
    }],
  });
  const result = evaluateOcrPredictions(corpus, partialGold, predictions, {
    assessments: [{
      goldId: 'attention-eq-1',
      predictionId: 'prediction-1',
      structureCorrect: true,
      cropComplete: true,
    }],
    predictionAssessments: [{ predictionId: 'prediction-1', validDisplayFormula: true }],
  });
  assert.equal(result.metrics.structureCorrectRate, 0.5);
  assert.equal(result.metrics.cropCompleteRate, 0.5);
  assert.equal(result.gate.status, 'fail');
});

test('归一化只消除排版差异，不吞掉公式 token', () => {
  assert.equal(normalizeLatex(String.raw`$$ \left( x + y \right) $$`), '(x+y)');
  assert.notEqual(normalizeLatex('x+y'), normalizeLatex('x-y'));
});

function mode() {
  return {
    texSourceShortcut: false,
    inlineFormulaPolicy: 'count-only',
    formulaListScope: 'display-and-numbered',
  };
}

function predictionSet(overrides) {
  return {
    schemaVersion: 1,
    engine: 'fixture-engine',
    evaluationMode: mode(),
    environment: { summary: 'unit-test' },
    papers: [{ id: '1706.03762', status: 'completed', durationMs: 1000 }],
    formulas: [],
    ...overrides,
  };
}
