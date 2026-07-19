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
