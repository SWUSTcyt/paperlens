import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { detectPdfFormulaCandidates, isMathFontName } from '../src/pdf/formulaHeuristic.ts';
import { detectHeading } from '../src/pdf/structure.ts';
import { buildPageLines, stripHeadersFooters } from '../src/pdf/textLayout.ts';

const PAPERS = [
  ['1706.03762', 'Attention Is All You Need'],
  ['1412.6980', 'Adam'],
  ['2006.11239', 'DDPM'],
  ['1312.6114', 'VAE'],
  ['1512.03385', 'ResNet'],
  ['1502.03167', 'Batch Normalization'],
  ['1607.06450', 'Layer Normalization'],
  ['1810.04805', 'BERT'],
  ['2106.09685', 'LoRA'],
  ['1312.5602', 'DQN'],
  ['1406.2661', 'GAN'],
  ['1707.06347', 'PPO'],
  ['1806.07366', 'Neural ODE'],
];

const MATH_SYMBOL_PATTERN = /[∑∫∏√≤≥≈≠∞∂∇±×÷∈∉⊂⊃⊆⊇∪∩→←↔⇒⇔α-ωΑ-Ω₀-₉⁰-⁹ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]/gu;
const OPERATOR_PATTERN = /[=<>+*\/^_{}\[\]|]|(?:\b(?:sin|cos|tan|log|exp|max|min|arg)\b)/i;
const EQUATION_NUMBER_PATTERN = /\(\s*\d+(?:\.\d+)*\s*\)\s*$/;

const cacheDir = join(tmpdir(), 'paperlens-phase-c-formula-evaluation');
await mkdir(cacheDir, { recursive: true });

const paperArg = process.argv.find((argument) => argument.startsWith('--paper='))?.slice('--paper='.length);
const selectedPapers = paperArg ? PAPERS.filter(([id]) => id === paperArg) : PAPERS;
if (selectedPapers.length === 0) throw new Error(`未知样本：${paperArg}`);

const reports = [];
for (const [id, title] of selectedPapers) {
  process.stderr.write(`[eval] ${id} ${title}\n`);
  const data = await loadPdf(id);
  reports.push(await evaluatePdf(data, id, title));
}

const dumpPage = Number(process.argv.find((argument) => argument.startsWith('--dump-page='))?.slice('--dump-page='.length));
if (Number.isFinite(dumpPage)) {
  const paper = reports[0];
  process.stdout.write(`\nPAGE_LAYOUT_JSON\n${JSON.stringify(paper.pageDump?.[dumpPage] ?? [], null, 2)}\n`);
  process.exit(0);
}

const aggregateOnly = process.argv.includes('--aggregate');
const tableOnly = process.argv.includes('--table');
const summaryOnly = process.argv.includes('--summary');
const compact = process.argv.includes('--compact');
const payload = tableOnly
  ? reports.map((paper) => ({
      id: paper.id,
      support: paper.current.formulaSupport,
      candidates: paper.current.emitted,
      fragmentRisk: paper.current.fragmentRiskCount,
      fragmentRiskRatio: paper.current.fragmentRiskRatio,
      multilineBlocks: paper.current.multilineBlockCount,
      numberedCovered: paper.numberedProxy.coveredByCandidate,
      numberedTotal: paper.numberedProxy.total,
      numberedRecall: paper.numberedProxy.recall,
    }))
  : aggregateOnly
  ? { generatedAt: new Date().toISOString(), aggregate: aggregateReports(reports) }
  : summaryOnly
  ? {
      generatedAt: new Date().toISOString(),
      aggregate: aggregateReports(reports),
      papers: reports.map((paper) => ({
        id: paper.id,
        title: paper.title,
        pages: paper.pages,
        lineCount: paper.lineCount,
        fontSignals: paper.fontSignals,
        current: paper.current,
        scoreBands: paper.scoreBands,
        numberedProxy: paper.numberedProxy,
      })),
    }
  : compact
  ? {
      generatedAt: new Date().toISOString(),
      papers: reports.map((paper) => ({
        id: paper.id,
        title: paper.title,
        pages: paper.pages,
        lineCount: paper.lineCount,
        columns: paper.columns,
        fontSignals: paper.fontSignals,
        current: paper.current,
        scoreBands: paper.scoreBands,
        numberedProxy: paper.numberedProxy,
        examples: {
          fragmentRisks: paper.examples.fragmentRisks.slice(0, 2),
          nearMiss055: paper.examples.nearMiss055.slice(0, 2),
          numberedMisses: paper.examples.numberedMisses.slice(0, 2),
          splitClusters: paper.examples.splitClusters.slice(0, 2),
          candidateBlocks: paper.examples.candidateBlocks.slice(0, 8),
        },
      })),
    }
  : { generatedAt: new Date().toISOString(), papers: reports };
process.stdout.write(`\nPHASE_C_EVALUATION_JSON\n${JSON.stringify(payload, null, 2)}\n`);

async function loadPdf(id) {
  const path = join(cacheDir, `${id}.pdf`);
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    const response = await fetch(`https://arxiv.org/pdf/${id}`, {
      headers: { 'user-agent': 'PaperLens/0.0.1 PDF formula evaluation (local development)' },
    });
    if (!response.ok) throw new Error(`${id} 下载失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path, bytes);
    return bytes;
  }
}

async function evaluatePdf(data, id, title) {
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
  try {
    const document = await loadingTask.promise;
    const rawLines = [];
    const resolvedFonts = new Map();
    const sourceFonts = new Map();
    const embeddedFontNames = new Map();
    const mathFonts = new Map();
    const internalMathFonts = new Map();
    let rawItemCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const styles = content.styles ?? {};
      for (const item of content.items) {
        if (typeof item.str !== 'string' || !item.str.trim() || !item.fontName) continue;
        const embeddedName = readEmbeddedFontName(page, item.fontName);
        if (embeddedName) embeddedFontNames.set(embeddedName, (embeddedFontNames.get(embeddedName) ?? 0) + 1);
      }
      const items = normalizeItems(content.items, styles);
      rawItemCount += items.length;
      for (const item of items) {
        resolvedFonts.set(item.font, (resolvedFonts.get(item.font) ?? 0) + 1);
        sourceFonts.set(item.sourceFont, (sourceFonts.get(item.sourceFont) ?? 0) + 1);
        if (item.mathFont) mathFonts.set(item.font, (mathFonts.get(item.font) ?? 0) + 1);
        if (isMathFontName(item.sourceFont)) {
          internalMathFonts.set(item.sourceFont, (internalMathFonts.get(item.sourceFont) ?? 0) + 1);
        }
      }
      rawLines.push(...buildPageLines(items, viewport.width, viewport.height, pageNumber));
    }

    const lines = stripHeadersFooters(rawLines);
    const bodySize = estimateBodySize(lines);
    const eligible = scoreEligibleLines(lines, bodySize);
    const localAccepted = eligible.filter((entry) => entry.score >= 0.6);
    const detected = detectPdfFormulaCandidates(lines, bodySize, detectHeading);
    const diagnostics = detected.diagnostics ?? [];
    const emittedLineIndexes = new Set(diagnostics.flatMap((item) => item.sourceLineIndexes));
    const maxScore = detected.formulas.length
      ? Math.max(...detected.formulas.map((formula) => formula.confidence ?? 0))
      : 0;
    const numbered = eligible.filter((entry) => EQUATION_NUMBER_PATTERN.test(entry.line.text));
    const numberedAccepted = numbered.filter((entry) => entry.score >= 0.6);
    const numberedCovered = numbered.filter((entry) => emittedLineIndexes.has(entry.index));
    const fragmentRiskDetails = detected.formulas.map((formula, index) => ({
      formula,
      diagnostic: diagnostics[index],
      flags: formulaFragmentFlags(formula, diagnostics[index], eligible, bodySize),
    }));
    const fragmentRisks = fragmentRiskDetails.filter((entry) => entry.flags.length > 0);
    const splitClusters = findSplitClusters(eligible, bodySize);

    return {
      id,
      title,
      url: `https://arxiv.org/pdf/${id}`,
      pages: document.numPages,
      rawItemCount,
      lineCount: lines.length,
      bodySize,
      columns: {
        singleOrSpanning: lines.filter((line) => line.column === 0).length,
        left: lines.filter((line) => line.column === 1).length,
        right: lines.filter((line) => line.column === 2).length,
      },
      fontSignals: {
        resolvedMathItemCount: [...mathFonts.values()].reduce((sum, count) => sum + count, 0),
        internalMathItemCount: [...internalMathFonts.values()].reduce((sum, count) => sum + count, 0),
        topResolvedFonts: [...resolvedFonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        topInternalFonts: [...sourceFonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        topEmbeddedFontNames: [...embeddedFontNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
        resolvedMathFonts: [...mathFonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
        internalMathFonts: [...internalMathFonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      },
      current: {
        formulaSupport: detected.formulaSupport,
        emitted: detected.formulas.length,
        localAccepted: localAccepted.length,
        maxScore,
        documentGateSuppressed: localAccepted.length > 0 && maxScore < 0.65,
        fragmentRiskCount: fragmentRisks.length,
        fragmentRiskRatio: detected.formulas.length ? round(fragmentRisks.length / detected.formulas.length) : null,
        multilineBlockCount: detected.formulas.filter((formula) => formula.latex.includes('\n')).length,
        splitClusterCount: splitClusters.length,
      },
      scoreBands: {
        atLeast060: localAccepted.length,
        from055To059: eligible.filter((entry) => entry.score >= 0.55 && entry.score < 0.6).length,
        from050To054: eligible.filter((entry) => entry.score >= 0.5 && entry.score < 0.55).length,
        from045To049: eligible.filter((entry) => entry.score >= 0.45 && entry.score < 0.5).length,
        from034To044: eligible.filter((entry) => entry.score >= 0.34 && entry.score < 0.45).length,
      },
      numberedProxy: {
        total: numbered.length,
        localAccepted: numberedAccepted.length,
        coveredByCandidate: numberedCovered.length,
        atLeast055: numbered.filter((entry) => entry.score >= 0.55).length,
        atLeast034: numbered.filter((entry) => entry.score >= 0.34).length,
        emitted: numberedCovered.length,
        recall: numbered.length ? round(numberedCovered.length / numbered.length) : null,
      },
      examples: {
        accepted: selectExamples(localAccepted, eligible, 5),
        fragmentRisks: fragmentRisks.slice(0, 5).map((entry) => ({
          page: entry.formula.page,
          confidence: entry.formula.confidence,
          flags: entry.flags,
          text: entry.formula.latex,
          sourceLines: entry.diagnostic?.sourceLines ?? [],
        })),
        nearMiss055: selectExamples(eligible.filter((entry) => entry.score >= 0.55 && entry.score < 0.6), eligible, 5),
        numberedMisses: selectExamples(numbered.filter((entry) => entry.score < 0.6), eligible, 5),
        splitClusters: splitClusters.slice(0, 5),
        candidateBlocks: fragmentRiskDetails.slice(0, 8).map((entry) => ({
          page: entry.formula.page,
          confidence: entry.formula.confidence,
          flags: entry.flags,
          text: entry.formula.latex,
          sourceLines: entry.diagnostic?.sourceLines ?? [],
        })),
      },
      pageDump: Object.fromEntries([...new Set(lines.map((line) => line.page))].map((page) => [
        page,
        eligible.filter((entry) => entry.line.page === page).map((entry) => ({
          index: entry.index,
          column: entry.line.column,
          x: round(entry.line.x),
          y: round(entry.line.y),
          endX: round(entry.line.endX),
          score: entry.score,
          text: entry.line.text,
        })),
      ])),
    };
  } finally {
    await loadingTask.destroy();
  }
}

function normalizeItems(items, styles) {
  const output = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || item.str.trim() === '') continue;
    const transform = item.transform ?? [];
    const size = item.height > 0 ? item.height : Math.hypot(transform[1] ?? 0, transform[3] ?? 0) || 10;
    const font = styles[item.fontName]?.fontFamily || item.fontName || '';
    output.push({
      str: item.str,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      w: item.width ?? 0,
      size,
      font,
      sourceFont: item.fontName || '',
      mathFont: isMathFontName(font),
    });
  }
  return output;
}

function readEmbeddedFontName(page, fontName) {
  try {
    if (!page.commonObjs.has(fontName)) return '';
    const font = page.commonObjs.get(fontName);
    return [font?.name, font?.loadedName, font?.fallbackName, font?.cssFontInfo?.fontFamily]
      .filter((value) => typeof value === 'string' && value)
      .join(' | ');
  } catch {
    return '';
  }
}

function estimateBodySize(lines) {
  const counts = new Map();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

function scoreEligibleLines(lines, bodySize) {
  const entries = [];
  let collectingReferences = false;
  lines.forEach((line, index) => {
    const text = line.text.trim();
    const heading = detectHeading(line, bodySize);
    if (heading) {
      collectingReferences = /^(references|bibliography|参考文献)\b/i.test(text);
      return;
    }
    if (collectingReferences || !text || isPageEdge(line)) return;
    const diagnostic = scoreFormulaLine(line);
    entries.push({ index, line, ...diagnostic });
  });
  return entries;
}

// 与 formulaHeuristic.ts 当前实现逐项一致；这里额外保留信号，供离线诊断。
function scoreFormulaLine(line) {
  const text = line.text.trim();
  if (text.length < 3 || text.length > 240) return emptyScore();
  const mathFontRatio = Math.max(0, Math.min(1, line.mathFontRatio ?? (isMathFontName(line.font) ? 1 : 0)));
  const symbolCount = text.match(MATH_SYMBOL_PATTERN)?.length ?? 0;
  const operatorCount = text.match(new RegExp(OPERATOR_PATTERN.source, 'giu'))?.length ?? 0;
  const numbered = EQUATION_NUMBER_PATTERN.test(text);
  const width = Math.max(0, line.endX - line.x);
  const columnWidth = line.column === 0 ? line.pageWidth : line.pageWidth / 2;
  const columnCenter = line.column === 1
    ? line.pageWidth * 0.25
    : line.column === 2
      ? line.pageWidth * 0.75
      : line.pageWidth * 0.5;
  const centerOffset = Math.abs((line.x + line.endX) / 2 - columnCenter);
  const centeredShort = width <= columnWidth * (line.column === 0 ? 0.78 : 0.9) &&
    centerOffset <= columnWidth * 0.32;
  let score = 0;
  if (mathFontRatio >= 0.75) score += 0.62;
  else if (mathFontRatio >= 0.45) score += 0.5;
  else if (mathFontRatio >= 0.25) score += 0.34;
  if (symbolCount >= 3) score += 0.55;
  else if (symbolCount === 2) score += 0.44;
  else if (symbolCount === 1) score += 0.2;
  if (centeredShort && numbered && (mathFontRatio >= 0.25 || symbolCount > 0 || operatorCount > 0)) {
    score += 0.68;
  }
  if (operatorCount > 0) score += 0.12;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 12 && mathFontRatio < 0.45 && symbolCount < 3) score -= 0.35;
  if (/^[A-Za-z ]+[.!?:;]$/.test(text) && operatorCount === 0) score -= 0.35;
  return {
    score: round(Math.max(0, Math.min(1, score))),
    mathFontRatio: round(mathFontRatio),
    symbolCount,
    operatorCount,
    numbered,
    centeredShort,
  };
}

function emptyScore() {
  return { score: 0, mathFontRatio: 0, symbolCount: 0, operatorCount: 0, numbered: false, centeredShort: false };
}

function fragmentFlags(entry, eligible) {
  const text = entry.line.text.replace(EQUATION_NUMBER_PATTERN, '').trim();
  const flags = [];
  if (/^[),\]}=+*/]/.test(text) || /[=+*/([{]$/.test(text)) flags.push('broken-boundary');
  if (!balanced(text, '(', ')') || !balanced(text, '[', ']') || !balanced(text, '{', '}')) flags.push('unbalanced-delimiter');
  const position = eligible.indexOf(entry);
  const neighbors = [eligible[position - 1], eligible[position + 1]].filter(Boolean);
  if (neighbors.some((neighbor) => isLikelySameFormula(entry, neighbor))) flags.push('adjacent-math-line');
  return flags;
}

function formulaFragmentFlags(formula, diagnostic, eligible, bodySize) {
  const flags = [];
  const rows = formula.latex.split('\n').map((line) => line.trim()).filter(Boolean);
  const baseline = (rows[0] ?? '').replace(EQUATION_NUMBER_PATTERN, '').trim();
  if (/^[),\]}=+*/]/.test(baseline) || /[=+*/([{]$/.test(baseline)) flags.push('broken-boundary');
  if (!balanced(baseline, '(', ')') || !balanced(baseline, '[', ']') || !balanced(baseline, '{', '}')) {
    flags.push('unbalanced-delimiter');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(formula.latex)) flags.push('control-character');
  if (/^\(\s*\d+(?:\.\d+)*\s*\)$/.test(formula.latex.trim())) flags.push('number-only');

  const sourceIndexes = new Set(diagnostic?.sourceLineIndexes ?? []);
  const sourceEntries = eligible.filter((entry) => sourceIndexes.has(entry.index));
  const hasUnclaimedFragment = eligible.some((candidate) => {
    if (sourceIndexes.has(candidate.index) || !isEvaluationFormulaFragment(candidate)) return false;
    return sourceEntries.some((source) => canEvaluationLinesJoin(source.line, candidate.line, bodySize));
  });
  if (hasUnclaimedFragment) flags.push('unclaimed-math-line');
  return [...new Set(flags)];
}

function isEvaluationFormulaFragment(candidate) {
  const text = candidate.line.text.trim();
  if (!text || text.length > 160) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) return false;
  if (candidate.score > 0) return true;
  if ((text.match(MATH_SYMBOL_PATTERN)?.length ?? 0) > 0) return true;
  if (/^\(\s*\d+(?:\.\d+)*\s*\)$/.test(text)) return true;
  if (/[()[\]{}]/.test(text) && wordCount <= 4) return true;
  return /^(?:[A-Z]{1,8}|[a-z]{1,3}\d*|[α-ωΑ-Ω][A-Za-z0-9]*)$/.test(text);
}

function canEvaluationLinesJoin(a, b, bodySize) {
  if (a.page !== b.page) return false;
  const verticalGap = Math.abs(a.y - b.y);
  if (verticalGap > bodySize * 1.4) return false;
  const horizontalGap = Math.max(a.x, b.x) - Math.min(a.endX, b.endX);
  if (a.column === b.column) return horizontalGap <= bodySize * 4;
  return verticalGap <= bodySize * 1.1 && horizontalGap <= bodySize * 1.5;
}

function balanced(text, open, close) {
  let balance = 0;
  for (const character of text) {
    if (character === open) balance++;
    else if (character === close) balance--;
    if (balance < 0) return false;
  }
  return balance === 0;
}

function isLikelySameFormula(a, b) {
  if (a.line.page !== b.line.page || a.line.column !== b.line.column) return false;
  const gap = Math.abs(a.line.y - b.line.y);
  if (gap > Math.max(a.line.size, b.line.size) * 2.3) return false;
  const evidence = b.score >= 0.2 || b.mathFontRatio >= 0.15 || b.operatorCount > 0 || b.numbered;
  const short = b.line.text.length <= 100;
  const horizontalOverlap = Math.min(a.line.endX, b.line.endX) - Math.max(a.line.x, b.line.x);
  return evidence && short && horizontalOverlap > -a.line.pageWidth * 0.08;
}

function findSplitClusters(eligible, bodySize) {
  const clusters = [];
  let current = [];
  const flush = () => {
    if (current.length >= 2 && current.some((entry) => entry.score >= 0.6 || entry.numbered)) {
      clusters.push({
        page: current[0].line.page,
        lines: current.map((entry) => ({ score: entry.score, text: entry.line.text })),
      });
    }
    current = [];
  };
  for (const entry of eligible) {
    const formulaLike = entry.score >= 0.2 || entry.mathFontRatio >= 0.15 || entry.operatorCount > 0 || entry.numbered;
    const previous = current.at(-1);
    const adjacent = previous && entry.line.page === previous.line.page && entry.line.column === previous.line.column &&
      Math.abs(entry.line.y - previous.line.y) <= bodySize * 2.5;
    if (!formulaLike || (current.length && !adjacent)) flush();
    if (formulaLike) current.push(entry);
  }
  flush();
  return clusters;
}

function selectExamples(source, eligible, limit) {
  return source.slice(0, limit).map((entry) => {
    const position = eligible.indexOf(entry);
    return {
      page: entry.line.page,
      score: entry.score,
      mathFontRatio: entry.mathFontRatio,
      flags: fragmentFlags(entry, eligible),
      text: entry.line.text,
      previous: eligible[position - 1]?.line.page === entry.line.page ? eligible[position - 1].line.text : null,
      next: eligible[position + 1]?.line.page === entry.line.page ? eligible[position + 1].line.text : null,
    };
  });
}

function isPageEdge(line) {
  return line.y >= line.pageHeight * 0.9 || line.y <= line.pageHeight * 0.1;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function aggregateReports(items) {
  const numberedTotal = items.reduce((sum, paper) => sum + paper.numberedProxy.total, 0);
  const numberedAccepted = items.reduce((sum, paper) => sum + paper.numberedProxy.coveredByCandidate, 0);
  const numberedAtLeast055 = items.reduce((sum, paper) => sum + paper.numberedProxy.atLeast055, 0);
  const numberedAtLeast034 = items.reduce((sum, paper) => sum + paper.numberedProxy.atLeast034, 0);
  const emittedCandidates = items.reduce((sum, paper) => sum + paper.current.emitted, 0);
  const fragmentRiskCount = items.reduce((sum, paper) => sum + paper.current.fragmentRiskCount, 0);
  return {
    papers: items.length,
    pages: items.reduce((sum, paper) => sum + paper.pages, 0),
    heuristic: items.filter((paper) => paper.current.formulaSupport === 'heuristic').length,
    none: items.filter((paper) => paper.current.formulaSupport === 'none').length,
    emittedCandidates,
    fragmentRiskCount,
    fragmentRiskRatio: emittedCandidates ? round(fragmentRiskCount / emittedCandidates) : null,
    multilineBlockCount: items.reduce((sum, paper) => sum + paper.current.multilineBlockCount, 0),
    splitClusterCount: items.reduce((sum, paper) => sum + paper.current.splitClusterCount, 0),
    nearMiss055Count: items.reduce((sum, paper) => sum + paper.scoreBands.from055To059, 0),
    numberedTotal,
    numberedAccepted,
    numberedRecall: numberedTotal ? round(numberedAccepted / numberedTotal) : null,
    numberedAtLeast055,
    numberedRecallAt055: numberedTotal ? round(numberedAtLeast055 / numberedTotal) : null,
    numberedAtLeast034,
    numberedRecallAt034: numberedTotal ? round(numberedAtLeast034 / numberedTotal) : null,
  };
}
