import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { adaptMineruDocument, buildMineruPredictionSet } from './mineruPoc.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const runRoot = resolve(requiredOption('run'));
const outputPath = resolve(option('output') ?? join(runRoot, 'predictions.json'));
const corpus = JSON.parse(await readFile(join(repoRoot, 'tests', 'fixtures', 'pdf-ocr-corpus.json'), 'utf8'));
const run = JSON.parse(await readFile(join(runRoot, 'run-manifest.json'), 'utf8'));
const backend = run.command?.backend ?? 'pipeline';
const outputRoot = resolve(runRoot, run.outputRoot ?? 'output');
const documents = [];
const failures = [];

for (const paper of corpus.papers) {
  const paperRun = run.papers.find((candidate) => candidate.id === paper.id);
  if (paperRun?.status !== 'completed') {
    failures.push({
      paperId: paper.id,
      durationMs: paperRun?.durationMs ?? 0,
      error: paperRun?.error ?? 'run manifest 中没有完成记录',
    });
    continue;
  }
  try {
    const contentRoot = join(outputRoot, paper.id, 'auto');
    const contentList = JSON.parse(await readFile(join(contentRoot, `${paper.id}_content_list.json`), 'utf8'));
    const middle = await readOptionalJson(join(contentRoot, `${paper.id}_middle.json`));
    const document = adaptMineruDocument({ paper, backend, contentList, middle });
    document.durationMs = paperRun.durationMs;
    document.formulas = document.formulas.map((formula) => ({
      ...formula,
      cropPath: formula.cropPath ? slash(resolve(contentRoot, formula.cropPath)) : null,
    }));
    documents.push(document);
  } catch (error) {
    failures.push({
      paperId: paper.id,
      durationMs: paperRun.durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const predictions = buildMineruPredictionSet({
  version: '3.4.4',
  backend,
  environment: run.environment,
  documents,
  failures,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(predictions, null, 2)}\n`, 'utf8');
process.stdout.write(`MinerU 预测已写入 ${slash(relative(repoRoot, outputPath))}：${documents.length} 篇成功，${failures.length} 篇失败，${predictions.formulas.length} 条展示公式。\n`);

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
