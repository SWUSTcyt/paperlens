import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const corpus = JSON.parse(await readFile(join(root, 'tests', 'fixtures', 'pdf-ocr-corpus.json'), 'utf8'));
const artifacts = resolve(process.argv[2] ?? join(root, 'local-artifacts', 'pdf-ocr-poc'));
const referenceDir = join(artifacts, 'references');
const sourceDir = join(artifacts, 'source-archives');
await mkdir(referenceDir, { recursive: true });
await mkdir(sourceDir, { recursive: true });

for (const paper of corpus.papers) {
  const result = await fetchReference(paper.id);
  if (!result) {
    process.stderr.write(`[reference] ${paper.id} arXiv/ar5iv unavailable\n`);
    await writeFile(join(referenceDir, `${paper.id}.json`), `${JSON.stringify({
      paperId: paper.id,
      status: 'unavailable',
      equations: [],
    }, null, 2)}\n`);
    await downloadSourceReference(paper.id);
    continue;
  }
  const { html, equations, url } = result;
  const inlineCount = [...html.matchAll(/<math\b[^>]*\bdisplay="inline"/g)].length;
  const payload = {
    schemaVersion: 1,
    paperId: paper.id,
    status: 'available',
    referenceOnly: true,
    engineInput: false,
    referenceUrl: url,
    inlineCount,
    equations,
  };
  await writeFile(join(referenceDir, `${paper.id}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`[reference] ${paper.id} ${equations.length} numbered display equations\n`);
  await downloadSourceReference(paper.id);
}

async function downloadSourceReference(id) {
  const response = await fetch(`https://arxiv.org/src/${id}`, {
    credentials: 'omit',
    headers: { 'user-agent': 'PaperLens/0.0.1 local OCR gold reference builder' },
  });
  if (!response.ok) {
    process.stderr.write(`[source-reference] ${id} HTTP ${response.status}\n`);
    return;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) {
    throw new Error(`${id} source archive 超过 25 MiB`);
  }
  await writeFile(join(sourceDir, `${id}.bin`), bytes);
  process.stderr.write(`[source-reference] ${id} ${bytes.byteLength} bytes\n`);
}

async function fetchReference(id) {
  const urls = [
    `https://arxiv.org/html/${id}`,
    `https://ar5iv.labs.arxiv.org/html/${id}`,
  ];
  let fallback = null;
  for (const url of urls) {
    const response = await fetch(url, {
      credentials: 'omit',
      headers: { 'user-agent': 'PaperLens/0.0.1 local OCR gold reference builder' },
    });
    if (!response.ok) continue;
    const html = await response.text();
    const equations = extractNumberedEquations(html);
    const candidate = { html, equations, url };
    if (equations.length > 0) return candidate;
    fallback ??= candidate;
  }
  return fallback;
}

function extractNumberedEquations(html) {
  const output = [];
  // ar5iv 的多行公式把每一行标为 ltx_eqn_row，而单行公式通常标为
  // ltx_equation；两者都要读取，否则会漏掉正文中最重要的一批编号公式。
  const rowPattern = /<tr\b[^>]*class="[^"]*\b(?:ltx_equation|ltx_eqn_row)\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  for (const rowMatch of html.matchAll(rowPattern)) {
    const row = rowMatch[1];
    const mathMatch = row.match(/<math\b([^>]*\bdisplay="block"[^>]*)>/);
    const tagMatch = row.match(/class="[^"]*\bltx_tag_equation\b[^"]*"[^>]*>\s*\(([^<]+)\)/);
    if (!mathMatch || !tagMatch) continue;
    const altMatch = mathMatch[1].match(/\balttext="([^"]+)"/);
    if (!altMatch) continue;
    const idMatch = mathMatch[1].match(/\bid="([^"]+)"/);
    const latex = decodeEntities(altMatch[1]).trim();
    const number = decodeEntities(tagMatch[1]).trim();
    if (!latex || !number) continue;
    output.push({
      number,
      latex,
      htmlId: idMatch ? decodeEntities(idMatch[1]) : null,
    });
  }
  return output;
}

function decodeEntities(value) {
  const named = new Map([
    ['amp', '&'],
    ['quot', '"'],
    ['apos', "'"],
    ['lt', '<'],
    ['gt', '>'],
  ]);
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return named.get(body.toLowerCase()) ?? entity;
  });
}
