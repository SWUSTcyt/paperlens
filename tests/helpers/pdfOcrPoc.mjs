const DISPLAY_SCOPES = new Set(['display-and-numbered']);
const INLINE_POLICIES = new Set(['count-only']);

export function validateCorpus(corpus) {
  const errors = [];
  if (corpus?.schemaVersion !== 1) errors.push('corpus.schemaVersion 必须为 1');
  validateEvaluationMode(corpus?.evaluationMode, errors, 'corpus.evaluationMode');
  if (!Array.isArray(corpus?.papers) || corpus.papers.length === 0) {
    errors.push('corpus.papers 必须是非空数组');
    return errors;
  }

  const ids = new Set();
  for (const [index, paper] of corpus.papers.entries()) {
    const path = `corpus.papers[${index}]`;
    if (!/^\d{4}\.\d{4,5}$/.test(paper?.id ?? '')) errors.push(`${path}.id 不是新式 arXiv ID`);
    if (ids.has(paper?.id)) errors.push(`${path}.id 重复：${paper.id}`);
    ids.add(paper?.id);
    if (typeof paper?.title !== 'string' || !paper.title.trim()) errors.push(`${path}.title 不能为空`);
    if (!Number.isInteger(paper?.pages) || paper.pages < 1) errors.push(`${path}.pages 必须为正整数`);
  }
  return errors;
}

export function validateGoldDataset(corpus, gold, options = {}) {
  const errors = validateCorpus(corpus);
  const minimumFormulas = options.minimumFormulas ?? 0;
  if (gold?.schemaVersion !== 1) errors.push('gold.schemaVersion 必须为 1');
  if (gold?.coordinateSystem !== 'top-left-0-1000') {
    errors.push('gold.coordinateSystem 必须为 top-left-0-1000');
  }
  validateEvaluationMode(gold?.evaluationMode, errors, 'gold.evaluationMode');
  if (!Array.isArray(gold?.formulas)) {
    errors.push('gold.formulas 必须是数组');
    return errors;
  }
  if (gold.formulas.length < minimumFormulas) {
    errors.push(`gold.formulas 至少需要 ${minimumFormulas} 条，当前为 ${gold.formulas.length} 条`);
  }

  const papers = new Map((corpus?.papers ?? []).map((paper) => [paper.id, paper]));
  const ids = new Set();
  for (const [index, formula] of gold.formulas.entries()) {
    const path = `gold.formulas[${index}]`;
    if (typeof formula?.id !== 'string' || !formula.id.trim()) errors.push(`${path}.id 不能为空`);
    if (ids.has(formula?.id)) errors.push(`${path}.id 重复：${formula.id}`);
    ids.add(formula?.id);
    const paper = papers.get(formula?.paperId);
    if (!paper) errors.push(`${path}.paperId 不在语料中：${formula?.paperId ?? ''}`);
    if (!Number.isInteger(formula?.page) || formula.page < 1 || (paper && formula.page > paper.pages)) {
      errors.push(`${path}.page 超出论文页数`);
    }
    validateBbox(formula?.bbox, errors, `${path}.bbox`);
    if (typeof formula?.latex !== 'string' || !formula.latex.trim()) errors.push(`${path}.latex 不能为空`);
    if (formula?.latex === '__TRANSCRIBE__') errors.push(`${path}.latex 尚未完成人工转写`);
    if (formula?.display !== true) errors.push(`${path}.display 必须为 true`);
    if (typeof formula?.category !== 'string' || !formula.category.trim()) {
      errors.push(`${path}.category 不能为空`);
    }
    if (formula?.equationNumber !== undefined && typeof formula.equationNumber !== 'string') {
      errors.push(`${path}.equationNumber 必须为字符串`);
    }
    if (formula?.core !== undefined && typeof formula.core !== 'boolean') {
      errors.push(`${path}.core 必须为布尔值`);
    }
  }
  return errors;
}

export function assertValidGoldDataset(corpus, gold, options) {
  const errors = validateGoldDataset(corpus, gold, options);
  if (errors.length) throw new Error(`PDF OCR 金标校验失败：\n- ${errors.join('\n- ')}`);
}

export function evaluateOcrPredictions(corpus, gold, predictions, reviews = { assessments: [] }) {
  assertValidGoldDataset(corpus, gold);
  const predictionErrors = validatePredictions(corpus, predictions);
  if (predictionErrors.length) {
    throw new Error(`PDF OCR 预测校验失败：\n- ${predictionErrors.join('\n- ')}`);
  }

  const matches = matchPredictions(gold.formulas, predictions.formulas);
  const assessments = new Map((reviews?.assessments ?? []).map((item) => [
    `${item.goldId}\u0000${item.predictionId}`,
    item,
  ]));
  const predictionAssessments = new Map((reviews?.predictionAssessments ?? []).map((item) => [
    item.predictionId,
    item,
  ]));
  const matchedPredictionIds = new Set(matches.map((match) => match.prediction.id));
  const paperRuns = new Map((predictions.papers ?? []).map((paper) => [paper.id, paper]));
  let exactLatex = 0;
  const renderable = predictions.formulas.filter((formula) => formula.katexRenderable === true).length;
  let reviewed = 0;
  let structureCorrect = 0;
  let cropComplete = 0;

  for (const match of matches) {
    if (normalizeLatex(match.gold.latex) === normalizeLatex(match.prediction.latex)) exactLatex += 1;
    const assessment = assessments.get(`${match.gold.id}\u0000${match.prediction.id}`);
    if (typeof assessment?.structureCorrect === 'boolean' && typeof assessment?.cropComplete === 'boolean') {
      reviewed += 1;
      if (assessment.structureCorrect === true) structureCorrect += 1;
      if (assessment.cropComplete === true) cropComplete += 1;
    }
  }

  const coreGold = gold.formulas.filter((formula) => formula.core === true);
  const matchedByGold = new Map(matches.map((match) => [match.gold.id, match]));
  const corePassed = coreGold.every((formula) => {
    const match = matchedByGold.get(formula.id);
    if (!match) return false;
    return assessments.get(`${formula.id}\u0000${match.prediction.id}`)?.structureCorrect === true;
  });
  const failedPapers = corpus.papers.filter((paper) => paperRuns.get(paper.id)?.status !== 'completed');
  const reviewedPredictions = predictions.formulas.filter((formula) => (
    typeof predictionAssessments.get(formula.id)?.validDisplayFormula === 'boolean'
  ));
  const validPredictions = reviewedPredictions.filter((formula) => (
    predictionAssessments.get(formula.id)?.validDisplayFormula === true
  ));
  const precisionReviewComplete = reviewedPredictions.length === predictions.formulas.length;
  const matchReviewComplete = reviewed === matches.length;

  const metrics = {
    goldCount: gold.formulas.length,
    predictionCount: predictions.formulas.length,
    matchedCount: matches.length,
    detectionRecall: ratio(matches.length, gold.formulas.length),
    detectionPrecision: precisionReviewComplete
      ? ratio(validPredictions.length, predictions.formulas.length)
      : null,
    exactLatexRate: ratio(exactLatex, gold.formulas.length),
    katexRenderableRate: ratio(renderable, predictions.formulas.length),
    reviewedMatchCount: reviewed,
    reviewedPredictionCount: reviewedPredictions.length,
    structureCorrectRate: matchReviewComplete ? ratio(structureCorrect, gold.formulas.length) : null,
    cropCompleteRate: matchReviewComplete ? ratio(cropComplete, gold.formulas.length) : null,
    corePassed: coreGold.length > 0 && matchReviewComplete ? corePassed : null,
    documentFailureCount: failedPapers.length,
  };

  return {
    engine: predictions.engine,
    texSourceShortcut: predictions.evaluationMode.texSourceShortcut,
    metrics,
    gate: evaluateP1Gate(metrics),
    matches,
    unmatchedGold: gold.formulas.filter((formula) => !matchedByGold.has(formula.id)),
    unmatchedPredictions: predictions.formulas.filter((formula) => !matchedPredictionIds.has(formula.id)),
    failedPapers,
  };
}

export function evaluateP1Gate(metrics) {
  const pending = metrics.detectionPrecision === null
    || metrics.structureCorrectRate === null
    || metrics.cropCompleteRate === null
    || metrics.corePassed === null;
  if (pending) return { status: 'pending', reason: '人工完整度与裁剪审核尚未覆盖全部金标' };
  const checks = {
    detectionRecall: metrics.detectionRecall >= 0.92,
    detectionPrecision: metrics.detectionPrecision >= 0.85,
    structureCorrectRate: metrics.structureCorrectRate >= 0.85,
    cropCompleteRate: metrics.cropCompleteRate >= 0.95,
    katexRenderableRate: metrics.katexRenderableRate >= 0.95,
    corePassed: metrics.corePassed === true,
    documentFailureCount: metrics.documentFailureCount === 0,
  };
  return {
    status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
    checks,
  };
}

export function buildMarkdownReport(result, predictions) {
  const percent = (value) => value === null ? '待人工' : `${(value * 100).toFixed(1)}%`;
  const rows = [
    ['展示公式区域召回率', percent(result.metrics.detectionRecall), '≥92%'],
    ['公式区域精确率', percent(result.metrics.detectionPrecision), '≥85%'],
    ['完整且结构正确', percent(result.metrics.structureCorrectRate), '≥85%'],
    ['裁剪完整率', percent(result.metrics.cropCompleteRate), '≥95%'],
    ['KaTeX 可渲染率', percent(result.metrics.katexRenderableRate), '≥95%'],
    ['核心公式', result.metrics.corePassed === null ? '待人工' : result.metrics.corePassed ? '通过' : '失败', '全部通过'],
    ['文档失败', String(result.metrics.documentFailureCount), '0'],
  ];
  return [
    `# PDF OCR POC：${result.engine}`,
    '',
    `- TeX 源捷径：${result.texSourceShortcut ? '开启（无效评测）' : '关闭'}`,
    `- P1 裁决：**${result.gate.status}**`,
    `- 环境：${predictions.environment?.summary ?? '未记录'}`,
    '',
    '| 指标 | 结果 | 门槛 |',
    '|---|---:|---:|',
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} |`),
    '',
    `未命中金标：${result.unmatchedGold.length}；未匹配预测：${result.unmatchedPredictions.length}。`,
    '',
  ].join('\n');
}

export function normalizeLatex(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\$\$?|\$\$?$/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/\s+/g, '');
}

function validateEvaluationMode(mode, errors, path) {
  if (mode?.texSourceShortcut !== false) errors.push(`${path}.texSourceShortcut 必须为 false`);
  if (!INLINE_POLICIES.has(mode?.inlineFormulaPolicy)) {
    errors.push(`${path}.inlineFormulaPolicy 必须为 count-only`);
  }
  if (!DISPLAY_SCOPES.has(mode?.formulaListScope)) {
    errors.push(`${path}.formulaListScope 必须为 display-and-numbered`);
  }
}

function validatePredictions(corpus, predictions) {
  const errors = [];
  if (predictions?.schemaVersion !== 1) errors.push('predictions.schemaVersion 必须为 1');
  validateEvaluationMode(predictions?.evaluationMode, errors, 'predictions.evaluationMode');
  if (typeof predictions?.engine !== 'string' || !predictions.engine.trim()) errors.push('predictions.engine 不能为空');
  if (!Array.isArray(predictions?.papers)) errors.push('predictions.papers 必须是数组');
  if (!Array.isArray(predictions?.formulas)) {
    errors.push('predictions.formulas 必须是数组');
    return errors;
  }
  const corpusIds = new Set(corpus.papers.map((paper) => paper.id));
  const ids = new Set();
  for (const [index, formula] of predictions.formulas.entries()) {
    const path = `predictions.formulas[${index}]`;
    if (typeof formula?.id !== 'string' || !formula.id.trim()) errors.push(`${path}.id 不能为空`);
    if (ids.has(formula?.id)) errors.push(`${path}.id 重复：${formula.id}`);
    ids.add(formula?.id);
    if (!corpusIds.has(formula?.paperId)) errors.push(`${path}.paperId 不在语料中`);
    if (!Number.isInteger(formula?.page) || formula.page < 1) errors.push(`${path}.page 必须为正整数`);
    validateBbox(formula?.bbox, errors, `${path}.bbox`);
    if (typeof formula?.latex !== 'string' || !formula.latex.trim()) errors.push(`${path}.latex 不能为空`);
    if (formula?.display !== true) errors.push(`${path}.display 必须为 true`);
  }
  return errors;
}

function validateBbox(bbox, errors, path) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
    errors.push(`${path} 必须是四个有限数字`);
    return;
  }
  const [x0, y0, x1, y1] = bbox;
  if (x0 < 0 || y0 < 0 || x1 > 1000 || y1 > 1000 || x0 >= x1 || y0 >= y1) {
    errors.push(`${path} 必须满足 0≤x0<x1≤1000 且 0≤y0<y1≤1000`);
  }
}

function matchPredictions(gold, predictions) {
  const candidates = [];
  for (const goldFormula of gold) {
    for (const prediction of predictions) {
      if (goldFormula.paperId !== prediction.paperId || goldFormula.page !== prediction.page) continue;
      const overlap = overlapOnSmallerBox(goldFormula.bbox, prediction.bbox);
      if (overlap >= 0.5 || centerInside(prediction.bbox, goldFormula.bbox)) {
        candidates.push({ gold: goldFormula, prediction, overlap });
      }
    }
  }
  candidates.sort((a, b) => b.overlap - a.overlap);
  const usedGold = new Set();
  const usedPredictions = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (usedGold.has(candidate.gold.id) || usedPredictions.has(candidate.prediction.id)) continue;
    usedGold.add(candidate.gold.id);
    usedPredictions.add(candidate.prediction.id);
    matches.push(candidate);
  }
  return matches;
}

function overlapOnSmallerBox(a, b) {
  const [ax0, ay0, ax1, ay1] = a;
  const [bx0, by0, bx1, by1] = b;
  const width = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const height = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const intersection = width * height;
  const smaller = Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0));
  return smaller > 0 ? intersection / smaller : 0;
}

function centerInside(inner, outer) {
  const x = (inner[0] + inner[2]) / 2;
  const y = (inner[1] + inner[3]) / 2;
  return x >= outer[0] && x <= outer[2] && y >= outer[1] && y <= outer[3];
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}
