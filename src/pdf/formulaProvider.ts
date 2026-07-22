import type {
  Formula,
  PaperContent,
  Section,
} from '../extractors/types';
import type { MineruClient, MineruClientErrorCode } from '../mineru/client';
import type { MineruHealth, MineruJobResult, MineruJobStatus } from '../mineru/contracts';
import type { MineruLocalSettings } from '../mineru/settings';

export type PdfFormulaFallbackReason =
  | 'not-pdf'
  | 'config-invalid'
  | 'connection-failed'
  | 'service-not-ready'
  | 'auth-failed'
  | 'version-incompatible'
  | 'upload-failed'
  | 'queue-full'
  | 'job-failed'
  | 'timeout'
  | 'invalid-result';

export type PdfFormulaEnhancementResult =
  | { kind: 'enhanced'; paper: PaperContent; jobId: string }
  | { kind: 'fallback'; paper: PaperContent; reason: PdfFormulaFallbackReason }
  | { kind: 'cancelled'; paper: PaperContent }
  | { kind: 'disabled'; paper: PaperContent };

export interface PdfFormulaProviderClient {
  getHealth(signal?: AbortSignal): Promise<MineruHealth>;
  createJob(pdf: Blob, filename?: string, signal?: AbortSignal): Promise<MineruJobStatus>;
  getJob(jobId: string, signal?: AbortSignal): Promise<MineruJobStatus>;
  cancelJob(jobId: string, signal?: AbortSignal): Promise<MineruJobStatus>;
}

export interface PdfFormulaEnhancementOptions {
  baseline: PaperContent;
  pdfBytes: ArrayBuffer;
  settings: MineruLocalSettings;
  signal?: AbortSignal;
  onStatus?: (status: MineruJobStatus) => void;
  client?: PdfFormulaProviderClient;
  pollIntervalMs?: number;
  taskTimeoutMs?: number;
  filename?: string;
}

/**
 * PDF 公式增强的事务边界。TeX 源 provider 后续可在调用本函数前插入；本轮不实现网络取源。
 * 任何失败都返回传入的 baseline 原对象，只有完整成功才创建并返回新 PaperContent。
 */
export async function enhancePdfFormulas(
  options: PdfFormulaEnhancementOptions,
): Promise<PdfFormulaEnhancementResult> {
  const { baseline, settings, signal } = options;
  if (baseline.source !== 'pdf') return { kind: 'disabled', paper: baseline };
  if (!settings.enabled) return { kind: 'disabled', paper: baseline };
  if (signal?.aborted) return { kind: 'cancelled', paper: baseline };

  let client: PdfFormulaProviderClient;
  try {
    client = options.client ?? await createDefaultClient(settings);
  } catch (error) {
    return { kind: 'fallback', paper: baseline, reason: mapClientError(error, 'config-invalid') };
  }

  const startedAt = Date.now();
  const taskTimeoutMs = options.taskTimeoutMs ?? 30 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  let jobId: string | null = null;

  try {
    const health = await client.getHealth(signal);
    if (health.status !== 'ready') {
      return { kind: 'fallback', paper: baseline, reason: 'service-not-ready' };
    }
    const created = await client.createJob(
      new Blob([options.pdfBytes], { type: 'application/pdf' }),
      options.filename ?? 'paper.pdf',
      signal,
    );
    jobId = created.jobId;
    options.onStatus?.(created);
    let status = created;

    while (!isTerminal(status)) {
      if (signal?.aborted) {
        await cancelQuietly(client, jobId);
        return { kind: 'cancelled', paper: baseline };
      }
      if (Date.now() - startedAt >= taskTimeoutMs) {
        await cancelQuietly(client, jobId);
        return { kind: 'fallback', paper: baseline, reason: 'timeout' };
      }
      await waitForNextPoll(pollIntervalMs, signal);
      status = await client.getJob(jobId, signal);
      options.onStatus?.(status);
    }

    if (status.state === 'cancelled') return { kind: 'cancelled', paper: baseline };
    if (status.state === 'timed-out') return { kind: 'fallback', paper: baseline, reason: 'timeout' };
    if (status.state !== 'completed') {
      return {
        kind: 'fallback',
        paper: baseline,
        reason: status.error?.code === 'RESULT_INVALID' ? 'invalid-result' : 'job-failed',
      };
    }
    if (!status.result) return { kind: 'fallback', paper: baseline, reason: 'invalid-result' };

    if (status.result.jobId !== jobId) {
      return { kind: 'fallback', paper: baseline, reason: 'invalid-result' };
    }
    try {
      const enhanced = mergeMineruResult(baseline, status.result);
      return { kind: 'enhanced', paper: enhanced, jobId };
    } catch {
      return { kind: 'fallback', paper: baseline, reason: 'invalid-result' };
    }
  } catch (error) {
    if (signal?.aborted || clientErrorCode(error) === 'ABORTED') {
      if (jobId) await cancelQuietly(client, jobId);
      return { kind: 'cancelled', paper: baseline };
    }
    if (jobId) await cancelQuietly(client, jobId);
    const defaultReason = jobId ? 'job-failed' : 'upload-failed';
    return { kind: 'fallback', paper: baseline, reason: mapClientError(error, defaultReason) };
  }
}

export function mergeMineruResult(
  baseline: PaperContent,
  result: MineruJobResult,
): PaperContent {
  if (baseline.source !== 'pdf' || result.document.pageCount !== baseline.pageCount) {
    throw new Error('MinerU 结果与 PDF 基线不匹配');
  }
  const formulas: Formula[] = result.formulas.map((formula, index) => ({
    id: index + 1,
    latex: formula.latex,
    display: true,
    sectionPath: formula.sectionPath,
    context: formula.context,
    page: formula.page,
    bbox: [...formula.bbox],
    recognitionSource: 'mineru-ocr',
    cropRef: formula.cropId
      ? { provider: 'mineru-local', jobId: result.jobId, cropId: formula.cropId }
      : undefined,
  }));
  const sections = cloneSectionsWithoutFormulas(baseline.sections);
  assignOcrFormulasToSections(sections, formulas);
  const serviceWarnings = result.warnings.map((warning) => warning.message);
  return {
    ...baseline,
    sections,
    formulas,
    formulaSupport: 'ocr',
    formulaRecognition: {
      provider: 'mineru-local',
      engine: { ...result.engine },
      displayFormulaCount: result.document.displayFormulaCount,
      inlineFormulaCount: result.document.inlineFormulaCount,
      warnings: serviceWarnings,
    },
  };
}

async function createDefaultClient(settings: MineruLocalSettings): Promise<PdfFormulaProviderClient> {
  const module = await import('../mineru/client');
  return new module.MineruClient(settings);
}

function cloneSectionsWithoutFormulas(sections: Section[]): Section[] {
  return sections.map((section) => ({
    ...section,
    paragraphs: [...section.paragraphs],
    formulaIds: [],
    children: cloneSectionsWithoutFormulas(section.children),
  }));
}

function assignOcrFormulasToSections(sections: Section[], formulas: Formula[]): void {
  const entries: Array<{ section: Section; path: string[] }> = [];
  const walk = (nodes: Section[], parents: string[]) => {
    for (const section of nodes) {
      const path = [...parents, normalizeHeading(section.heading)];
      entries.push({ section, path });
      walk(section.children, path);
    }
  };
  walk(sections, []);

  const fallbackByPage = new Map<number, Section>();
  for (const formula of formulas) {
    const sourcePath = (formula.sectionPath ?? '')
      .split('>')
      .map(normalizeHeading)
      .filter(Boolean);
    const match = entries
      .filter((entry) => pathEndsWith(sourcePath, entry.path))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (match) {
      match.section.formulaIds.push(formula.id);
      continue;
    }
    const page = formula.page ?? 0;
    let fallback = fallbackByPage.get(page);
    if (!fallback) {
      fallback = {
        level: 1,
        heading: page > 0 ? `第 ${page} 页 / 其他公式` : '其他公式',
        paragraphs: [],
        formulaIds: [],
        children: [],
      };
      sections.push(fallback);
      fallbackByPage.set(page, fallback);
    }
    fallback.formulaIds.push(formula.id);
  }
}

function pathEndsWith(source: string[], candidate: string[]): boolean {
  if (candidate.length === 0 || source.length < candidate.length) return false;
  return candidate.every((part, index) => source[source.length - candidate.length + index] === part);
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function isTerminal(status: MineruJobStatus): boolean {
  return ['completed', 'cancelled', 'failed', 'timed-out'].includes(status.state);
}

function waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function cancelQuietly(client: PdfFormulaProviderClient, jobId: string): Promise<void> {
  try {
    await client.cancelJob(jobId);
  } catch {
    // 回退路径不得被二次清理错误覆盖。
  }
}

function mapClientError(
  error: unknown,
  fallback: PdfFormulaFallbackReason,
): PdfFormulaFallbackReason {
  const mappings: Partial<Record<MineruClientErrorCode, PdfFormulaFallbackReason>> = {
    CONFIG_INVALID: 'config-invalid',
    CONNECTION_FAILED: 'connection-failed',
    TIMEOUT: 'timeout',
    AUTH_FAILED: 'auth-failed',
    VERSION_INCOMPATIBLE: 'version-incompatible',
    SERVICE_NOT_READY: 'service-not-ready',
    INVALID_RESPONSE: 'invalid-result',
    QUEUE_FULL: 'queue-full',
    JOB_FAILED: 'job-failed',
    JOB_TIMED_OUT: 'timeout',
    PDF_REJECTED: 'upload-failed',
  };
  return mappings[clientErrorCode(error) as MineruClientErrorCode] ?? fallback;
}

function clientErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
