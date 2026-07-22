import type {
  MineruFormulaResult,
  MineruHealth,
  MineruJobResult,
  MineruJobStage,
  MineruJobState,
  MineruJobStatus,
} from './contracts';

const MINERU_SCHEMA_VERSION = 1 as const;
const MINERU_ENGINE = Object.freeze({ name: 'mineru', version: '3.4.4', backend: 'pipeline' });

export type MineruClientErrorCode =
  | 'CONFIG_INVALID'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'AUTH_FAILED'
  | 'VERSION_INCOMPATIBLE'
  | 'SERVICE_NOT_READY'
  | 'INVALID_RESPONSE'
  | 'JOB_NOT_FOUND'
  | 'QUEUE_FULL'
  | 'JOB_FAILED'
  | 'JOB_TIMED_OUT'
  | 'PDF_REJECTED';

export class MineruClientError extends Error {
  readonly code: MineruClientErrorCode;

  constructor(
    code: MineruClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MineruClientError';
    this.code = code;
  }
}

export interface MineruClientOptions {
  port: number;
  accessToken: string;
  fetchImpl?: typeof fetch;
}

const HEALTH_TIMEOUT_MS = 3_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CROP_BYTES = 20 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const JOB_STATES = new Set<MineruJobState>([
  'accepted', 'queued', 'running', 'completed', 'cancelling', 'cancelled', 'failed', 'timed-out',
]);
const JOB_STAGES = new Set<MineruJobStage>([
  'accepted', 'queued', 'preparing', 'loading-model', 'parsing', 'normalizing', 'crops-ready',
  'completed', 'cancelling', 'cancelled', 'failed', 'timed-out',
]);

export function buildMineruBaseUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new MineruClientError('CONFIG_INVALID', '本地 MinerU 端口必须是 1024–65535 的整数。');
  }
  return `http://127.0.0.1:${port}`;
}

export class MineruClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MineruClientOptions) {
    this.baseUrl = buildMineruBaseUrl(options.port);
    if (!TOKEN_PATTERN.test(options.accessToken)) {
      throw new MineruClientError('CONFIG_INVALID', '本地 MinerU token 未配置或格式无效。');
    }
    this.token = options.accessToken;
    // 浏览器原生 fetch 不能作为实例方法用错误的 this 调用，否则会在发请求前抛 Illegal invocation。
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getHealth(signal?: AbortSignal): Promise<MineruHealth> {
    const response = await this.request('/v1/health', { method: 'GET' }, HEALTH_TIMEOUT_MS, signal, false);
    return parseHealth(await readJson(response));
  }

  async testConnection(signal?: AbortSignal): Promise<MineruHealth> {
    const health = await this.getHealth(signal);
    if (health.status !== 'ready') {
      throw new MineruClientError('SERVICE_NOT_READY', '本地 MinerU 服务尚未就绪。');
    }
    try {
      await this.getJob('job_paperlens_connection_probe', signal);
    } catch (error) {
      if (error instanceof MineruClientError && error.code === 'JOB_NOT_FOUND') return health;
      throw error;
    }
    throw new MineruClientError('INVALID_RESPONSE', '本地 MinerU 鉴权探针返回了意外结果。');
  }

  async createJob(pdf: Blob, filename = 'paper.pdf', signal?: AbortSignal): Promise<MineruJobStatus> {
    if (pdf.size <= 0 || pdf.size > 200 * 1024 * 1024) {
      throw new MineruClientError('PDF_REJECTED', 'PDF 为空或超过 200 MiB 上限。');
    }
    const form = new FormData();
    form.append('file', pdf, filename);
    const response = await this.request('/v1/jobs', { method: 'POST', body: form }, UPLOAD_TIMEOUT_MS, signal);
    return parseJobStatus(await readJson(response));
  }

  async getJob(jobId: string, signal?: AbortSignal): Promise<MineruJobStatus> {
    const response = await this.request(`/v1/jobs/${validateId(jobId)}`, { method: 'GET' }, REQUEST_TIMEOUT_MS, signal);
    return parseJobStatus(await readJson(response));
  }

  async cancelJob(jobId: string, signal?: AbortSignal): Promise<MineruJobStatus> {
    const response = await this.request(
      `/v1/jobs/${validateId(jobId)}/cancel`,
      { method: 'POST' },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return parseJobStatus(await readJson(response));
  }

  async deleteJob(jobId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/v1/jobs/${validateId(jobId)}`, { method: 'DELETE' }, REQUEST_TIMEOUT_MS, signal);
  }

  async getCrop(jobId: string, cropId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.request(
      `/v1/jobs/${validateId(jobId)}/crops/${validateId(cropId)}`,
      { method: 'GET' },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!contentType || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      throw new MineruClientError('INVALID_RESPONSE', '本地 MinerU 返回了不支持的裁剪图格式。');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_CROP_BYTES) {
      throw new MineruClientError('INVALID_RESPONSE', '本地 MinerU 裁剪图超过大小上限。');
    }
    const blob = await response.blob();
    if (blob.size <= 0 || blob.size > MAX_CROP_BYTES) {
      throw new MineruClientError('INVALID_RESPONSE', '本地 MinerU 裁剪图为空或超过大小上限。');
    }
    return blob;
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
    authenticated = true,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const headers = new Headers(init.headers);
    if (authenticated) {
      headers.set('Authorization', `Bearer ${this.token}`);
      headers.set('X-PaperLens-Schema-Version', String(MINERU_SCHEMA_VERSION));
    }
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw await mapHttpError(response);
      return response;
    } catch (error) {
      if (error instanceof MineruClientError) throw error;
      if (controller.signal.aborted) {
        if (timedOut) throw new MineruClientError('TIMEOUT', '本地 MinerU 请求超时。');
        throw new MineruClientError('ABORTED', '已取消本地 MinerU 请求。');
      }
      throw new MineruClientError('CONNECTION_FAILED', '无法连接本地 MinerU 服务。');
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
    }
  }
}

export function parseHealth(payload: unknown): MineruHealth {
  const root = object(payload, 'health');
  exactKeys(root, ['schemaVersion', 'service', 'serviceVersion', 'status', 'engine', 'limits', 'capabilities']);
  if (root.schemaVersion !== 1) versionError();
  if (root.service !== 'paperlens-mineru' || typeof root.serviceVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(root.serviceVersion)) {
    invalidResponse();
  }
  if (!['starting', 'ready', 'degraded'].includes(String(root.status))) invalidResponse();
  parseEngine(root.engine);
  const limits = object(root.limits, 'limits');
  exactKeys(limits, ['maxPdfBytes', 'maxPdfPages', 'maxConcurrentJobs', 'taskTimeoutSeconds', 'resultTtlSeconds']);
  if (
    limits.maxPdfBytes !== 209715200 || limits.maxPdfPages !== 500 || limits.maxConcurrentJobs !== 1
    || limits.taskTimeoutSeconds !== 1800 || limits.resultTtlSeconds !== 86400
  ) invalidResponse();
  const capabilities = object(root.capabilities, 'capabilities');
  exactKeys(capabilities, ['displayFormulas', 'inlineFormulaCount', 'crops', 'truthfulPageProgress']);
  if (
    capabilities.displayFormulas !== true || capabilities.inlineFormulaCount !== true
    || capabilities.crops !== true || capabilities.truthfulPageProgress !== false
  ) invalidResponse();
  return payload as MineruHealth;
}

export function parseJobStatus(payload: unknown): MineruJobStatus {
  const root = object(payload, 'job status');
  keys(root, ['schemaVersion', 'jobId', 'state', 'stage', 'stageStartedAt', 'elapsedMs'], ['queuePosition', 'result', 'error']);
  if (root.schemaVersion !== 1) versionError();
  responseId(root.jobId);
  if (!JOB_STATES.has(root.state as MineruJobState) || !JOB_STAGES.has(root.stage as MineruJobStage)) invalidResponse();
  if (typeof root.stageStartedAt !== 'string' || !Number.isInteger(root.elapsedMs) || Number(root.elapsedMs) < 0) invalidResponse();
  if (root.queuePosition !== undefined && (!Number.isInteger(root.queuePosition) || Number(root.queuePosition) < 0)) invalidResponse();
  if (root.state === 'completed' && root.result === undefined) invalidResponse();
  if (root.result !== undefined) {
    const result = parseJobResult(root.result);
    if (result.jobId !== root.jobId) invalidResponse();
  }
  if (root.error !== undefined) parseStatusError(root.error);
  return payload as MineruJobStatus;
}

export function parseJobResult(payload: unknown): MineruJobResult {
  const root = object(payload, 'job result');
  exactKeys(root, ['schemaVersion', 'jobId', 'engine', 'document', 'formulas', 'warnings']);
  if (root.schemaVersion !== 1) versionError();
  responseId(root.jobId);
  parseEngine(root.engine);
  const document = object(root.document, 'document');
  exactKeys(document, ['pageCount', 'displayFormulaCount', 'inlineFormulaCount']);
  integer(document.pageCount, 1, 500);
  integer(document.displayFormulaCount, 0, 100000);
  integer(document.inlineFormulaCount, 0, 1000000);
  if (!Array.isArray(root.formulas) || root.formulas.length !== document.displayFormulaCount) invalidResponse();
  const formulas = root.formulas.map((formula) => parseFormula(formula, Number(document.pageCount)));
  if (new Set(formulas.map((formula) => formula.id)).size !== formulas.length) invalidResponse();
  if (!Array.isArray(root.warnings)) invalidResponse();
  root.warnings.forEach(parseWarning);
  return payload as MineruJobResult;
}

function parseFormula(payload: unknown, pageCount: number): MineruFormulaResult {
  const item = object(payload, 'formula');
  keys(item, ['id', 'latex', 'page', 'bbox'], ['cropId', 'sectionPath', 'context']);
  responseId(item.id);
  if (typeof item.latex !== 'string' || item.latex.length < 1 || item.latex.length > 200000) invalidResponse();
  integer(item.page, 1, pageCount);
  if (!Array.isArray(item.bbox) || item.bbox.length !== 4) invalidResponse();
  item.bbox.forEach((value) => integer(value, 0, 1000));
  const [x0, y0, x1, y1] = item.bbox as number[];
  if (x0 >= x1 || y0 >= y1) invalidResponse();
  if (item.cropId !== undefined) responseId(item.cropId);
  optionalString(item.sectionPath, 500);
  optionalString(item.context, 2000);
  return payload as MineruFormulaResult;
}

function parseEngine(payload: unknown): void {
  const engine = object(payload, 'engine');
  exactKeys(engine, ['name', 'version', 'backend']);
  if (engine.name !== MINERU_ENGINE.name || engine.version !== MINERU_ENGINE.version || engine.backend !== MINERU_ENGINE.backend) {
    versionError();
  }
}

function parseWarning(payload: unknown): void {
  const warning = object(payload, 'warning');
  exactKeys(warning, ['code', 'message']);
  responseId(warning.code);
  if (typeof warning.message !== 'string' || warning.message.length < 1 || warning.message.length > 1000) invalidResponse();
}

function parseStatusError(payload: unknown): void {
  const error = object(payload, 'status error');
  exactKeys(error, ['code', 'message']);
  responseId(error.code);
  if (typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000) invalidResponse();
}

async function mapHttpError(response: Response): Promise<MineruClientError> {
  let serviceCode = '';
  try {
    const payload = object(await response.json(), 'error');
    exactKeys(payload, ['schemaVersion', 'requestId', 'error']);
    if (payload.schemaVersion !== 1) versionError();
    validateId(payload.requestId);
    const detail = object(payload.error, 'error detail');
    exactKeys(detail, ['code', 'message']);
    serviceCode = typeof detail.code === 'string' ? detail.code : '';
  } catch (error) {
    if (error instanceof MineruClientError && error.code === 'VERSION_INCOMPATIBLE') return error;
    return new MineruClientError('INVALID_RESPONSE', '本地 MinerU 返回了无效错误响应。');
  }
  const mappings: Record<string, [MineruClientErrorCode, string]> = {
    AUTH_REQUIRED: ['AUTH_FAILED', '本地 MinerU 需要访问 token。'],
    AUTH_INVALID: ['AUTH_FAILED', '本地 MinerU token 无效。'],
    VERSION_INCOMPATIBLE: ['VERSION_INCOMPATIBLE', '本地 MinerU 协议版本不兼容。'],
    SERVICE_NOT_READY: ['SERVICE_NOT_READY', '本地 MinerU 服务尚未就绪。'],
    JOB_NOT_FOUND: ['JOB_NOT_FOUND', '本地 MinerU 任务不存在或已过期。'],
    QUEUE_FULL: ['QUEUE_FULL', '本地 MinerU 队列已满。'],
    JOB_TIMED_OUT: ['JOB_TIMED_OUT', '本地 MinerU 任务已超时。'],
    PDF_INVALID: ['PDF_REJECTED', '本地 MinerU 无法读取该 PDF。'],
    PDF_TOO_LARGE: ['PDF_REJECTED', 'PDF 超过本地 MinerU 大小上限。'],
    PDF_TOO_MANY_PAGES: ['PDF_REJECTED', 'PDF 超过本地 MinerU 页数上限。'],
    RESULT_INVALID: ['INVALID_RESPONSE', '本地 MinerU 返回了无效结果。'],
  };
  const mapped = mappings[serviceCode];
  if (mapped) return new MineruClientError(...mapped);
  if (response.status === 401) return new MineruClientError('AUTH_FAILED', '本地 MinerU token 无效。');
  if (response.status === 503) return new MineruClientError('SERVICE_NOT_READY', '本地 MinerU 服务尚未就绪。');
  return new MineruClientError('JOB_FAILED', '本地 MinerU 请求失败。');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MineruClientError('INVALID_RESPONSE', '本地 MinerU 返回了无效 JSON。');
  }
}

function object(value: unknown, _name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  keys(value, expected, []);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[]): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) invalidResponse();
}

function integer(value: unknown, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) invalidResponse();
}

function optionalString(value: unknown, maximum: number): void {
  if (value !== undefined && (typeof value !== 'string' || value.length < 1 || value.length > maximum)) invalidResponse();
}

function validateId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new MineruClientError('CONFIG_INVALID', '本地 MinerU 标识无效。');
  }
  return value;
}

function responseId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalidResponse();
  return value;
}

function invalidResponse(): never {
  throw new MineruClientError('INVALID_RESPONSE', '本地 MinerU 返回了不符合 schema v1 的响应。');
}

function versionError(): never {
  throw new MineruClientError('VERSION_INCOMPATIBLE', '本地 MinerU 协议或引擎版本不兼容。');
}
