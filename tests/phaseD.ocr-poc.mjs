import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import katex from 'katex';

import {
  assertValidGoldDataset,
  buildMarkdownReport,
  evaluateOcrPredictions,
} from './helpers/pdfOcrPoc.mjs';

const root = resolve(import.meta.dirname, '..');
const corpusPath = join(import.meta.dirname, 'fixtures', 'pdf-ocr-corpus.json');
const goldPath = join(import.meta.dirname, 'fixtures', 'pdf-ocr-gold.json');
const defaultArtifacts = join(root, 'local-artifacts', 'pdf-ocr-poc');
const command = process.argv[2] ?? 'validate';
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const gold = JSON.parse(await readFile(goldPath, 'utf8'));

if (command === 'validate') {
  assertValidGoldDataset(corpus, gold, { minimumFormulas: 65 });
  assertGoldRenderable(gold);
  process.stdout.write(`POC A 金标有效：${corpus.papers.length} 篇，${gold.formulas.length} 条展示/编号公式，TeX 捷径关闭。\n`);
} else if (command === 'prepare') {
  const artifacts = resolve(option('artifacts') ?? defaultArtifacts);
  assertIgnoredArtifactPath(artifacts);
  await prepareCorpus(artifacts);
} else if (command === 'evaluate') {
  assertValidGoldDataset(corpus, gold, { minimumFormulas: 65 });
  const predictionsPath = requiredOption('predictions');
  const reviewsPath = option('reviews');
  const predictions = JSON.parse(await readFile(resolve(predictionsPath), 'utf8'));
  for (const formula of predictions.formulas ?? []) {
    try {
      katex.renderToString(formula.latex, { throwOnError: true, displayMode: true });
      formula.katexRenderable = true;
    } catch {
      formula.katexRenderable = false;
    }
  }
  const reviews = reviewsPath
    ? JSON.parse(await readFile(resolve(reviewsPath), 'utf8'))
    : { assessments: [] };
  const result = evaluateOcrPredictions(corpus, gold, predictions, reviews);
  const markdown = buildMarkdownReport(result, predictions);
  const output = option('output');
  if (output) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, 'utf8');
  }
  process.stdout.write(`${markdown}\nPDF_OCR_POC_JSON\n${JSON.stringify({ ...result, matches: undefined }, null, 2)}\n`);
} else {
  throw new Error(`未知命令：${command}；可用命令为 validate / prepare / evaluate`);
}

async function prepareCorpus(artifacts) {
  const pdfDir = join(artifacts, 'pdfs');
  await mkdir(pdfDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    evaluationMode: corpus.evaluationMode,
    artifactRoot: relative(root, artifacts).replaceAll('\\', '/'),
    papers: [],
  };
  for (const paper of corpus.papers) {
    const path = join(pdfDir, `${paper.id}.pdf`);
    const startedAt = performance.now();
    let source = 'cache';
    try {
      await stat(path);
    } catch {
      source = 'download';
      const response = await fetch(`https://arxiv.org/pdf/${paper.id}`, {
        credentials: 'omit',
        headers: { 'user-agent': 'PaperLens/0.0.1 local PDF OCR POC' },
      });
      if (!response.ok) throw new Error(`${paper.id} 下载失败：HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertPdf(bytes, paper.id);
      await writeFile(path, bytes);
    }
    const bytes = await readFile(path);
    assertPdf(bytes, paper.id);
    manifest.papers.push({
      id: paper.id,
      title: paper.title,
      pages: paper.pages,
      file: `pdfs/${basename(path)}`,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      source,
      prepareMs: Math.round(performance.now() - startedAt),
    });
    process.stderr.write(`[prepare] ${paper.id} ${source} ${bytes.byteLength} bytes\n`);
  }
  const manifestPath = join(artifacts, 'corpus-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`本地语料已准备：${manifestPath}\n`);
}

function assertIgnoredArtifactPath(path) {
  const allowedRoot = resolve(root, 'local-artifacts');
  const rel = relative(allowedRoot, path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`artifacts 必须位于已忽略目录 ${allowedRoot}`);
  }
}

function assertPdf(bytes, id) {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 1024)).toString('latin1');
  if (!prefix.includes('%PDF-')) throw new Error(`${id} 不是有效 PDF`);
}

function assertGoldRenderable(dataset) {
  const failures = [];
  for (const formula of dataset.formulas) {
    try {
      katex.renderToString(formula.latex, { throwOnError: true, displayMode: true });
    } catch (error) {
      failures.push(`${formula.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    throw new Error(`金标中有 ${failures.length} 条 LaTeX 无法由 KaTeX 渲染：\n- ${failures.join('\n- ')}`);
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
