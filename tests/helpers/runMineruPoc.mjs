import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');
const artifactRoot = resolve(option('artifacts') ?? join(repoRoot, 'local-artifacts', 'pdf-ocr-poc'));
const mineruRoot = resolve(option('mineru-root') ?? join(artifactRoot, 'mineru-3.4.4'));
const backend = option('backend') ?? 'pipeline';
const effort = option('effort') ?? 'high';
const port = Number(option('port') ?? 18080);
const force = process.argv.includes('--force');
const runRoot = resolve(option('output') ?? join(mineruRoot, `run-${backend}-${effort}`));
const outputRoot = join(runRoot, 'output');
const logRoot = join(runRoot, 'logs');
const manifestPath = join(artifactRoot, 'corpus-manifest.json');
const pythonBin = join(mineruRoot, '.venv312', 'Scripts');
const apiExe = join(pythonBin, 'mineru-api.exe');
const cliExe = join(pythonBin, 'mineru.exe');
const apiUrl = `http://127.0.0.1:${port}`;

assertLocalArtifactPath(artifactRoot);
await mkdir(outputRoot, { recursive: true });
await mkdir(logRoot, { recursive: true });

const corpus = JSON.parse(await readFile(manifestPath, 'utf8'));
const env = buildMineruEnvironment();
const previousManifest = await readOptionalJson(join(runRoot, 'run-manifest.json'));
const manifest = previousManifest?.engine === `mineru-3.4.4/${backend}` ? previousManifest : {
  schemaVersion: 1,
  engine: `mineru-3.4.4/${backend}`,
  evaluationMode: corpus.evaluationMode,
  startedAt: new Date().toISOString(),
  command: {
    backend,
    effort,
    formula: true,
    table: true,
    texSourceShortcut: false,
  },
  environment: await collectEnvironment(),
  papers: [],
};
manifest.finishedAt = undefined;

const apiLog = createWriteStream(join(logRoot, 'mineru-api.log'), { flags: 'a' });
const api = spawn(apiExe, ['--host', '127.0.0.1', '--port', String(port)], {
  cwd: mineruRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
api.stdout.pipe(apiLog);
api.stderr.pipe(apiLog);

let stopping = false;
const stopApi = () => {
  if (stopping) return;
  stopping = true;
  if (api.exitCode === null) {
    api.once('close', () => apiLog.end());
    if (process.platform === 'win32' && api.pid) {
      // Windows 的 .exe 启动器会再派生 Python；只 kill 父进程会留下 API 子进程。
      spawn('taskkill.exe', ['/PID', String(api.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (!api.killed) {
      api.kill();
    }
  } else {
    apiLog.end();
  }
};
process.once('SIGINT', stopApi);
process.once('SIGTERM', stopApi);

try {
  await waitForApi(apiUrl, api, Number(option('api-timeout-ms') ?? 240_000));
  process.stdout.write(`[MinerU] API ready: ${apiUrl}\n`);
  for (const paper of corpus.papers) {
    const previousPaper = manifest.papers.find((candidate) => candidate.id === paper.id);
    const inputPath = join(artifactRoot, paper.file);
    const expected = join(outputRoot, paper.id, 'auto', `${paper.id}_content_list.json`);
    if (!force && previousPaper?.status === 'completed' && await exists(expected)) {
      process.stdout.write(`[MinerU] ${paper.id} reused\n`);
      continue;
    }
    manifest.papers = manifest.papers.filter((candidate) => candidate.id !== paper.id);
    const startedAt = performance.now();
    const logPath = join(logRoot, `${paper.id}.log`);
    const args = [
      '-p', inputPath,
      '-o', outputRoot,
      '--api-url', apiUrl,
      '-b', backend,
      '--effort', effort,
      '-f', 'true',
      '-t', 'true',
    ];
    process.stdout.write(`[MinerU] ${paper.id} started\n`);
    try {
      const result = await runAndCapture(cliExe, args, {
        cwd: mineruRoot,
        env,
        logPath,
        api,
        timeoutMs: Number(option('paper-timeout-ms') ?? 1_800_000),
      });
      manifest.papers.push({
        id: paper.id,
        status: 'completed',
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: result.exitCode,
        log: slash(relative(runRoot, logPath)),
      });
      process.stdout.write(`[MinerU] ${paper.id} completed (${manifest.papers.at(-1).durationMs} ms)\n`);
    } catch (error) {
      manifest.papers.push({
        id: paper.id,
        status: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
        log: slash(relative(runRoot, logPath)),
      });
      process.stderr.write(`[MinerU] ${paper.id} failed: ${manifest.papers.at(-1).error}\n`);
    }
    await checkpoint();
  }
} finally {
  stopApi();
  manifest.finishedAt = new Date().toISOString();
  manifest.totalDurationMs = manifest.papers.reduce((sum, paper) => sum + paper.durationMs, 0);
  manifest.outputRoot = slash(relative(runRoot, outputRoot));
  await checkpoint();
}

async function checkpoint() {
  await writeFile(join(runRoot, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function buildMineruEnvironment() {
  return {
    ...process.env,
    HF_HOME: join(mineruRoot, 'models', 'huggingface'),
    MODELSCOPE_CACHE: join(mineruRoot, 'models', 'modelscope'),
    MINERU_MODEL_SOURCE: 'modelscope',
    MINERU_TOOLS_CONFIG_JSON: join(mineruRoot, 'mineru.json'),
    MINERU_API_OUTPUT_ROOT: join(mineruRoot, 'api-output'),
    MINERU_PROCESSING_WINDOW_SIZE: '4',
    MINERU_API_MAX_CONCURRENT_REQUESTS: '1',
  };
}

async function waitForApi(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`mineru-api 启动失败，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/openapi.json`);
      if (response.ok) return;
    } catch {
      // 服务导入模型相关模块较慢，继续轮询。
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`等待 mineru-api 就绪超时（${timeoutMs} ms）`);
}

function runAndCapture(executable, args, { cwd, env, logPath, api, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const log = createWriteStream(logPath, { flags: 'w' });
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      api.off('close', handleApiClose);
      log.end();
      callback();
    };
    const handleApiClose = () => {
      if (!child.killed) child.kill();
      finish(() => rejectPromise(new Error('mineru-api 在文档处理期间退出')));
    };
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill();
      finish(() => rejectPromise(new Error(`单篇处理超过 ${timeoutMs} ms`)));
    }, timeoutMs);
    api.once('close', handleApiClose);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.once('error', (error) => {
      finish(() => rejectPromise(error));
    });
    child.once('close', (exitCode) => {
      finish(() => {
        if (exitCode === 0) resolvePromise({ exitCode });
        else rejectPromise(new Error(`mineru 退出码 ${exitCode}`));
      });
    });
  });
}

async function collectEnvironment() {
  let gpu = null;
  try {
    const result = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader',
    ]);
    gpu = result.stdout.trim();
  } catch {
    // 无 NVIDIA GPU 也是 pipeline 支持的有效环境。
  }
  return {
    summary: `${platform()} ${release()}, ${cpus()[0]?.model ?? 'unknown CPU'}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM`,
    node: process.version,
    cpuLogicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    gpu,
  };
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertLocalArtifactPath(path) {
  const allowed = resolve(repoRoot, 'local-artifacts');
  const rel = relative(allowed, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`artifacts 必须位于 ${allowed}`);
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function slash(value) {
  return value.replaceAll('\\', '/');
}
