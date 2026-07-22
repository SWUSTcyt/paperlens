export interface MineruEngine {
  name: 'mineru';
  version: '3.4.4';
  backend: 'pipeline';
}

export type MineruJobState =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'timed-out';

export type MineruJobStage =
  | 'accepted'
  | 'queued'
  | 'preparing'
  | 'loading-model'
  | 'parsing'
  | 'normalizing'
  | 'crops-ready'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'timed-out';

export interface MineruHealth {
  schemaVersion: 1;
  service: 'paperlens-mineru';
  serviceVersion: string;
  status: 'starting' | 'ready' | 'degraded';
  engine: MineruEngine;
  limits: {
    maxPdfBytes: 209715200;
    maxPdfPages: 500;
    maxConcurrentJobs: 1;
    taskTimeoutSeconds: 1800;
    resultTtlSeconds: 86400;
  };
  capabilities: {
    displayFormulas: true;
    inlineFormulaCount: true;
    crops: true;
    truthfulPageProgress: false;
  };
}

export interface MineruFormulaResult {
  id: string;
  latex: string;
  page: number;
  bbox: [number, number, number, number];
  cropId?: string;
  sectionPath?: string;
  context?: string;
}

export interface MineruJobResult {
  schemaVersion: 1;
  jobId: string;
  engine: MineruEngine;
  document: {
    pageCount: number;
    displayFormulaCount: number;
    inlineFormulaCount: number;
  };
  formulas: MineruFormulaResult[];
  warnings: Array<{ code: string; message: string }>;
}

export interface MineruJobStatus {
  schemaVersion: 1;
  jobId: string;
  state: MineruJobState;
  stage: MineruJobStage;
  stageStartedAt: string;
  elapsedMs: number;
  queuePosition?: number;
  result?: MineruJobResult;
  error?: { code: string; message: string };
}
