import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignFormulaIdsToSections,
  detectPdfFormulaCandidates,
  isMathFontName,
} from '../src/pdf/formulaHeuristic.ts';

test('数学字体、Unicode 数学符号和居中编号行可形成 PDF 公式候选', () => {
  const lines = [
    line('1 Introduction', { y: 740, size: 15, font: 'Times-Bold' }),
    line('We minimize the following objective.', { y: 700 }),
    line('E = mc2', { y: 660, x: 210, endX: 390, mathFontRatio: 0.82 }),
    line('L(θ) = ∑ᵢ pᵢ log pᵢ', { y: 620, x: 170, endX: 430 }),
    line('p(x) = q(x) + r(x) (3)', { y: 580, x: 180, endX: 420 }),
  ];

  const result = detectPdfFormulaCandidates(lines, 10);

  assert.equal(result.formulaSupport, 'heuristic');
  assert.equal(result.formulas.length, 3);
  assert.deepEqual(result.formulas.map((formula) => formula.id), [1, 2, 3]);
  assert.ok(result.formulas.every((formula) => formula.page === 1));
  assert.ok(result.formulas.every((formula) => (formula.confidence ?? 0) >= 0.6));
  assert.ok(result.formulas.every((formula) => formula.sectionPath === '1 Introduction'));
  assert.match(result.formulas[0].context ?? '', /minimize the following objective/);
});

test('普通正文、页眉和单字符噪声不会开启 heuristic 支持', () => {
  const result = detectPdfFormulaCandidates([
    line('Conference on Machine Learning 2026', { y: 785 }),
    line('This paragraph explains the training procedure in ordinary prose.', { y: 700 }),
    line('x', { y: 660, mathFontRatio: 1 }),
    line('12', { y: 20 }),
  ], 10);

  assert.equal(result.formulaSupport, 'none');
  assert.deepEqual(result.formulas, []);
});

test('公式 ID 写入对应章节且不改变无关章节', () => {
  const sections = [
    section('1 Introduction', [section('1.1 Objective')]),
    section('2 Results'),
  ];
  const formulas = [
    { id: 1, latex: 'x = y', display: true, sectionPath: '1 Introduction > 1.1 Objective' },
    { id: 2, latex: 'a = b', display: true, sectionPath: '2 Results' },
  ];

  assignFormulaIdsToSections(sections, formulas);

  assert.deepEqual(sections[0].formulaIds, []);
  assert.deepEqual(sections[0].children[0].formulaIds, [1]);
  assert.deepEqual(sections[1].formulaIds, [2]);
});

test('数学字体名称识别不把普通正文粗体当作数学字体', () => {
  assert.equal(isMathFontName('CMMI10'), true);
  assert.equal(isMathFontName('STIXTwoMath'), true);
  assert.equal(isMathFontName('TimesNewRomanPS-BoldMT'), false);
});

test('双栏编号公式按所在栏中心识别，不再因偏离整页中心而整篇降级', () => {
  const result = detectPdfFormulaCandidates([
    line('2 Residual Learning', { y: 740, size: 15, font: 'Times-Bold' }),
    line('we consider a building block defined as:', { y: 690, column: 1, x: 50, endX: 286 }),
    line('y = F(x,{Wi}) +x. (1)', { y: 660, column: 1, x: 123, endX: 286, pageWidth: 612 }),
  ], 10);

  assert.equal(result.formulaSupport, 'heuristic');
  assert.equal(result.formulas.length, 1);
  assert.match(result.formulas[0].latex, /y = F\(x,\{Wi\}\) \+x\. \(1\)/);
});

test('编号锚点把同一视觉带中被误分栏的 Attention 与 FFN 片段重建成块', () => {
  const result = detectPdfFormulaCandidates([
    line('3.2.1 Scaled Dot-Product Attention', { y: 740, size: 15, font: 'Times-Bold' }),
    line('Attention(Q, K, V', { y: 610, column: 1, x: 220, endX: 297 }),
    line('QKT', { y: 619, column: 2, x: 356, endX: 377 }),
    line(') = softmax( √ )V (1)', { y: 610, column: 2, x: 299, endX: 505 }),
    line('dk', { y: 602, column: 2, x: 366, endX: 376 }),
    line('The two most common attention functions are described next.', { y: 575 }),
    line('FFN(x) = max(0', { y: 520, column: 1, x: 190, endX: 312 }),
    line(', xW1 +b1)W2 +b2 (2)', { y: 520, column: 2, x: 313, endX: 500 }),
  ], 10);

  assert.equal(result.formulaSupport, 'heuristic');
  assert.equal(result.formulas.length, 2);
  assert.match(result.formulas[0].latex, /Attention\(Q, K, V/);
  assert.match(result.formulas[0].latex, /QKT/);
  assert.match(result.formulas[0].latex, /dk/);
  assert.match(result.formulas[0].latex, /softmax/);
  assert.match(result.formulas[1].latex, /FFN\(x\) = max\(0/);
  assert.match(result.formulas[1].latex, /xW1 \+b1\)W2 \+b2 \(2\)/);
  assert.doesNotMatch(result.formulas[0].latex, /most common attention/);
});

test('独立编号只关联邻近同栏公式碎片，不吞入正文或远处公式', () => {
  const result = detectPdfFormulaCandidates([
    line('2 Objective', { y: 740, size: 15, font: 'Times-Bold' }),
    line('The objective is written below.', { y: 700, column: 1, x: 50, endX: 280 }),
    line('∑T', { y: 665, column: 1, x: 145, endX: 170 }),
    line('Lt = (yt −f(xt))2', { y: 655, column: 1, x: 105, endX: 230 }),
    line('t=1', { y: 645, column: 1, x: 150, endX: 175 }),
    line('(3)', { y: 655, column: 1, x: 260, endX: 278 }),
    line('This sentence must remain context only.', { y: 615, column: 1, x: 50, endX: 280 }),
    line('z = x + 1 (4)', { y: 540, column: 1, x: 125, endX: 275 }),
  ], 10);

  assert.equal(result.formulaSupport, 'heuristic');
  assert.equal(result.formulas.length, 2);
  assert.match(result.formulas[0].latex, /∑T/);
  assert.match(result.formulas[0].latex, /Lt = \(yt −f\(xt\)\)2/);
  assert.match(result.formulas[0].latex, /t=1/);
  assert.match(result.formulas[0].latex, /\(3\)/);
  assert.doesNotMatch(result.formulas[0].latex, /context only/);
  assert.match(result.formulas[1].latex, /z = x \+ 1 \(4\)/);
});

test('栏中心编号门禁不把 BERT 风格的枚举正文当成公式', () => {
  const result = detectPdfFormulaCandidates([
    line('3 Training', { y: 740, size: 15, font: 'Times-Bold' }),
    line('the i-th token with (1) the [MASK] token 80% of', {
      y: 690, column: 1, x: 50, endX: 286, pageWidth: 612,
    }),
    line('the time (2) a random token 10% of the time (3)', {
      y: 678, column: 1, x: 50, endX: 286, pageWidth: 612,
    }),
    line('ing, (2) hypothesis-premise pairs in entailment, (3)', {
      y: 620, column: 2, x: 309, endX: 545, pageWidth: 612,
    }),
  ], 10);

  assert.equal(result.formulaSupport, 'none');
  assert.deepEqual(result.formulas, []);
});

function line(text, overrides = {}) {
  return {
    page: 1,
    pageWidth: 600,
    pageHeight: 800,
    column: 0,
    x: 50,
    y: 500,
    endX: 550,
    size: 10,
    font: 'Times-Roman',
    mathFontRatio: 0,
    text,
    ...overrides,
  };
}

function section(heading, children = []) {
  return { level: 1, heading, paragraphs: [], formulaIds: [], children };
}
