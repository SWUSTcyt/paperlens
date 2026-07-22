const EVALUATION_MODE = Object.freeze({
  texSourceShortcut: false,
  inlineFormulaPolicy: 'count-only',
  formulaListScope: 'display-and-numbered',
});

export function adaptMineruDocument({ paper, backend, contentList, middle = null }) {
  if (!Array.isArray(contentList)) throw new Error('MinerU content list 必须是数组');
  if (!paper?.id || !Number.isInteger(paper.pages)) throw new Error('paper 元数据无效');

  const formulas = [];
  const warnings = [];
  for (const entry of flattenContentList(contentList)) {
    if (!isDisplayEquation(entry.item)) continue;
    const pageIndex = resolvePageIndex(entry.item, entry.pageIndex);
    const latex = extractLatex(entry.item);
    const bbox = normalizeBbox(entry.item.bbox);
    const problems = [];
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= paper.pages) problems.push('页码越界');
    if (!bbox) problems.push('bbox 无效');
    if (!latex) problems.push('LaTeX 为空');
    if (problems.length) {
      warnings.push({ index: entry.index, problems });
      continue;
    }
    formulas.push({
      id: `mineru-${paper.id}-p${String(pageIndex + 1).padStart(2, '0')}-e${formulas.length + 1}`,
      paperId: paper.id,
      page: pageIndex + 1,
      bbox,
      latex,
      display: true,
      cropPath: entry.item.img_path ?? entry.item.image_path ?? null,
      sourceBackend: backend,
    });
  }

  return {
    paperId: paper.id,
    status: 'completed',
    formulas,
    inlineFormulaCount: countInlineEquations(middle),
    warnings,
  };
}

export function buildMineruPredictionSet({ version, backend, environment, documents, failures = [] }) {
  const completed = documents.map((document) => ({
    id: document.paperId,
    status: document.status ?? 'completed',
    durationMs: document.durationMs,
    inlineFormulaCount: document.inlineFormulaCount ?? 0,
    warningCount: document.warnings?.length ?? 0,
  }));
  const failed = failures.map((failure) => ({
    id: failure.paperId,
    status: 'failed',
    durationMs: failure.durationMs,
    error: failure.error,
  }));
  return {
    schemaVersion: 1,
    engine: `mineru-${version}/${backend}`,
    evaluationMode: { ...EVALUATION_MODE },
    environment,
    papers: [...completed, ...failed],
    formulas: documents.flatMap((document) => document.formulas ?? []),
  };
}

export function stripDisplayDelimiters(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]') && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function flattenContentList(contentList) {
  const nested = contentList.every(Array.isArray);
  if (nested) {
    return contentList.flatMap((page, pageIndex) => page.map((item, index) => ({ item, pageIndex, index })));
  }
  return contentList.map((item, index) => ({ item, pageIndex: null, index }));
}

function isDisplayEquation(item) {
  return item?.type === 'equation' || item?.type === 'equation_interline';
}

function resolvePageIndex(item, nestedPageIndex) {
  if (Number.isInteger(item?.page_idx)) return item.page_idx;
  return nestedPageIndex;
}

function extractLatex(item) {
  const value = item?.text ?? item?.content?.math_content ?? item?.content;
  return typeof value === 'string' ? stripDisplayDelimiters(value) : '';
}

function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((number) => !Number.isFinite(number))) return null;
  const scale = value.every((number) => number >= 0 && number <= 1) ? 1000 : 1;
  const bbox = value.map((number) => Math.round(number * scale));
  const [x0, y0, x1, y1] = bbox;
  if (x0 < 0 || y0 < 0 || x1 > 1000 || y1 > 1000 || x0 >= x1 || y0 >= y1) return null;
  return bbox;
}

function countInlineEquations(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countInlineEquations(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const own = value.type === 'inline_equation' || value.type === 'equation_inline' ? 1 : 0;
  return own + Object.entries(value).reduce((sum, [key, child]) => (
    key === 'type' ? sum : sum + countInlineEquations(child)
  ), 0);
}
