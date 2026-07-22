import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

import katex from 'katex';

import { evaluateOcrPredictions } from './pdfOcrPoc.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const predictionsPath = resolve(requiredOption('predictions'));
const outputPath = resolve(option('output') ?? join(dirname(predictionsPath), 'reviews.json'));
const htmlPath = resolve(option('html') ?? join(dirname(outputPath), 'review.html'));
const goldCropRoot = resolve(option('gold-crops') ?? join(repoRoot, 'local-artifacts', 'pdf-ocr-poc', 'gold-crops'));
const corpus = JSON.parse(await readFile(join(repoRoot, 'tests', 'fixtures', 'pdf-ocr-corpus.json'), 'utf8'));
const gold = JSON.parse(await readFile(join(repoRoot, 'tests', 'fixtures', 'pdf-ocr-gold.json'), 'utf8'));
const predictions = JSON.parse(await readFile(predictionsPath, 'utf8'));

for (const formula of predictions.formulas) {
  try {
    katex.renderToString(formula.latex, { throwOnError: true, displayMode: true });
    formula.katexRenderable = true;
  } catch {
    formula.katexRenderable = false;
  }
}
const result = evaluateOcrPredictions(corpus, gold, predictions);
const existing = await readOptionalJson(outputPath);
const existingMatches = new Map((existing?.assessments ?? []).map((item) => [
  `${item.goldId}\u0000${item.predictionId}`,
  item,
]));
const existingPredictions = new Map((existing?.predictionAssessments ?? []).map((item) => [item.predictionId, item]));
const reviews = {
  schemaVersion: 1,
  engine: predictions.engine,
  instructions: 'null 表示未审核；必须依据 PDF 裁剪图判断，不能用 KaTeX 可渲染代替结构正确。',
  assessments: result.matches.map(({ gold: goldFormula, prediction }) => ({
    goldId: goldFormula.id,
    predictionId: prediction.id,
    structureCorrect: existingMatches.get(`${goldFormula.id}\u0000${prediction.id}`)?.structureCorrect ?? null,
    cropComplete: existingMatches.get(`${goldFormula.id}\u0000${prediction.id}`)?.cropComplete ?? null,
    note: existingMatches.get(`${goldFormula.id}\u0000${prediction.id}`)?.note ?? '',
  })),
  predictionAssessments: predictions.formulas.map((prediction) => ({
    predictionId: prediction.id,
    validDisplayFormula: existingPredictions.get(prediction.id)?.validDisplayFormula ?? null,
    note: existingPredictions.get(prediction.id)?.note ?? '',
  })),
};

const cropFiles = await readdir(goldCropRoot, { recursive: true, withFileTypes: true });
const goldCrops = new Map();
for (const file of cropFiles) {
  if (!file.isFile() || !/\.(png|jpg|jpeg)$/i.test(file.name)) continue;
  const match = gold.formulas.find((formula) => file.name.includes(formula.id));
  if (match) goldCrops.set(match.id, join(file.parentPath, file.name));
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(reviews, null, 2)}\n`, 'utf8');
await writeFile(htmlPath, buildHtml(result, predictions, goldCrops), 'utf8');
process.stdout.write(`审核模板：${slash(relative(repoRoot, outputPath))}\n审核页：${slash(relative(repoRoot, htmlPath))}\n匹配 ${result.matches.length}/${gold.formulas.length}，候选 ${predictions.formulas.length}。\n`);

function buildHtml(result, predictionsValue, crops) {
  const matchRows = result.matches.map(({ gold: goldFormula, prediction, overlap }) => `
    <article>
      <h3>${escapeHtml(goldFormula.id)} ↔ ${escapeHtml(prediction.id)}（overlap ${(overlap * 100).toFixed(1)}%）</h3>
      <div class="images">
        ${imageTag(crops.get(goldFormula.id), '金标 PDF 裁剪')}
        ${imageTag(prediction.cropPath, 'MinerU 裁剪')}
      </div>
      <pre>GOLD: ${escapeHtml(goldFormula.latex)}\nPRED: ${escapeHtml(prediction.latex)}</pre>
      <p>structureCorrect: ____　cropComplete: ____　note: ____________________</p>
    </article>`).join('\n');
  const candidateRows = predictionsValue.formulas.map((prediction) => `
    <article>
      <h3>${escapeHtml(prediction.id)} · page ${prediction.page} · KaTeX ${prediction.katexRenderable ? 'OK' : 'FAIL'}</h3>
      ${imageTag(prediction.cropPath, 'MinerU 候选')}
      <pre>${escapeHtml(prediction.latex)}</pre>
      <p>validDisplayFormula: ____　note: ____________________</p>
    </article>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MinerU POC B 人工审核</title>
  <style>body{font-family:system-ui,sans-serif;max-width:1200px;margin:auto;padding:24px}article{border:1px solid #bbb;border-radius:8px;padding:16px;margin:16px 0}.images{display:grid;grid-template-columns:1fr 1fr;gap:12px}img{max-width:100%;border:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;padding:12px}.missing{color:#a00}</style>
  <h1>MinerU POC B 人工审核</h1><p>PDF-only；TeX 源捷径关闭。先审核 ${result.matches.length} 条金标匹配的结构与裁剪，再审核全部 ${predictionsValue.formulas.length} 条候选是否真为展示公式。</p>
  <h2>金标匹配</h2>${matchRows}<h2>全部候选</h2>${candidateRows}</html>`;
}

function imageTag(path, label) {
  return path
    ? `<figure><figcaption>${label}</figcaption><img src="${pathToUrl(path)}" alt="${label}"></figure>`
    : `<p class="missing">${label}缺失</p>`;
}

function pathToUrl(path) {
  return `file:///${slash(resolve(path))}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`缺少 --${name}=...`);
  return value;
}

function slash(value) {
  return value.replaceAll('\\', '/');
}
