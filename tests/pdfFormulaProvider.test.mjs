import assert from 'node:assert/strict';
import test from 'node:test';

import { enhancePdfFormulas, mergeMineruResult } from '../src/pdf/formulaProvider.ts';

test('禁用或非 PDF 来源不创建 client，并原样保留基线', async () => {
  const baseline = paper();
  let calls = 0;
  const client = fakeClient({ onCall: () => { calls += 1; } });
  const disabled = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: { enabled: false, port: 17860, accessToken: '' },
    client,
  });
  assert.equal(disabled.kind, 'disabled');
  assert.equal(disabled.paper, baseline);

  const html = { ...baseline, source: 'arxiv' };
  const notPdf = await enhancePdfFormulas({
    baseline: html,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    client,
  });
  assert.equal(notPdf.kind, 'disabled');
  assert.equal(notPdf.paper, html);
  assert.equal(calls, 0);
});

test('完整成功后一次性替换公式，重建章节并只保存 job/crop 标识', async () => {
  const baseline = paper();
  const original = structuredClone(baseline);
  const statuses = [runningStatus('parsing'), completedStatus(result())];
  const seenStages = [];
  const client = fakeClient({ statuses });
  const outcome = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    client,
    pollIntervalMs: 0,
    onStatus: (status) => seenStages.push(status.stage),
  });

  assert.equal(outcome.kind, 'enhanced');
  assert.notEqual(outcome.paper, baseline);
  assert.deepEqual(baseline, original);
  assert.equal(outcome.paper.formulaSupport, 'ocr');
  assert.equal(outcome.paper.formulas.length, 2);
  assert.deepEqual(outcome.paper.formulas[0], {
    id: 1,
    latex: 'a=b',
    display: true,
    sectionPath: 'Paper title > Methods > Attention',
    context: 'context one',
    page: 2,
    bbox: [100, 200, 300, 400],
    recognitionSource: 'mineru-ocr',
    cropRef: { provider: 'mineru-local', jobId: 'job_safe', cropId: 'crop_1' },
  });
  assert.deepEqual(outcome.paper.sections[0].children[0].formulaIds, [1]);
  assert.equal(outcome.paper.sections.at(-1).heading, '第 3 页 / 其他公式');
  assert.deepEqual(outcome.paper.sections.at(-1).formulaIds, [2]);
  assert.equal(outcome.paper.formulaRecognition.displayFormulaCount, 2);
  assert.equal(outcome.paper.formulaRecognition.inlineFormulaCount, 42);
  assert.deepEqual(seenStages, ['queued', 'parsing', 'completed']);
  assert.equal(JSON.stringify(outcome.paper).includes('local-artifacts'), false);
  assert.equal(JSON.stringify(outcome.paper).includes('http://127.0.0.1'), false);
});

test('上传前必须通过 health 就绪与版本门禁，预检失败不得创建 job', async () => {
  const baseline = paper();
  const calls = [];
  const success = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    client: fakeClient({
      statuses: [completedStatus(result())],
      onCall: (name) => calls.push(name),
    }),
    pollIntervalMs: 0,
  });
  assert.equal(success.kind, 'enhanced');
  assert.deepEqual(calls.slice(0, 2), ['health', 'create']);

  let created = false;
  const unavailable = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    client: fakeClient({
      healthError: Object.assign(new Error('private path'), { code: 'CONNECTION_FAILED' }),
      onCall: (name) => { if (name === 'create') created = true; },
    }),
  });
  assert.equal(unavailable.kind, 'fallback');
  assert.equal(unavailable.reason, 'connection-failed');
  assert.equal(created, false);
});

test('明确的 0 展示公式是增强成功，不会被误判为失败', async () => {
  const baseline = paper();
  const zero = result();
  zero.document.displayFormulaCount = 0;
  zero.document.inlineFormulaCount = 58;
  zero.formulas = [];
  const outcome = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    client: fakeClient({ statuses: [completedStatus(zero)] }),
    pollIntervalMs: 0,
  });
  assert.equal(outcome.kind, 'enhanced');
  assert.deepEqual(outcome.paper.formulas, []);
  assert.equal(outcome.paper.formulaRecognition.displayFormulaCount, 0);
  assert.equal(outcome.paper.formulaRecognition.inlineFormulaCount, 58);
  assert.equal(outcome.paper.sections[0].children[0].formulaIds.length, 0);
});

test('配置、连接、401、版本、队列、上传和非法响应都确定性回退原基线', async () => {
  const cases = [
    ['CONFIG_INVALID', 'config-invalid'],
    ['CONNECTION_FAILED', 'connection-failed'],
    ['AUTH_FAILED', 'auth-failed'],
    ['VERSION_INCOMPATIBLE', 'version-incompatible'],
    ['SERVICE_NOT_READY', 'service-not-ready'],
    ['QUEUE_FULL', 'queue-full'],
    ['PDF_REJECTED', 'upload-failed'],
    ['INVALID_RESPONSE', 'invalid-result'],
  ];
  for (const [code, reason] of cases) {
    const baseline = paper();
    const outcome = await enhancePdfFormulas({
      baseline,
      pdfBytes: pdfBytes(),
      settings: enabledSettings(),
      client: fakeClient({ createError: Object.assign(new Error('private path'), { code }) }),
      pollIntervalMs: 0,
    });
    assert.equal(outcome.kind, 'fallback', code);
    assert.equal(outcome.reason, reason, code);
    assert.equal(outcome.paper, baseline, code);
  }
});

test('job 失败、超时、损坏结果和取消均不混入半份公式', async () => {
  const failed = await runWithStatuses([failedStatus('JOB_FAILED')]);
  assert.equal(failed.kind, 'fallback');
  assert.equal(failed.reason, 'job-failed');

  const invalid = await runWithStatuses([failedStatus('RESULT_INVALID')]);
  assert.equal(invalid.kind, 'fallback');
  assert.equal(invalid.reason, 'invalid-result');

  const badPageCount = result();
  badPageCount.document.pageCount = 99;
  const damaged = await runWithStatuses([completedStatus(badPageCount)]);
  assert.equal(damaged.kind, 'fallback');
  assert.equal(damaged.reason, 'invalid-result');

  let cancelCalls = 0;
  const controller = new AbortController();
  const baseline = paper();
  const cancelled = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    signal: controller.signal,
    client: fakeClient({
      onCancel: () => { cancelCalls += 1; },
    }),
    pollIntervalMs: 0,
    onStatus: () => controller.abort(),
  });
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(cancelled.paper, baseline);
  assert.equal(cancelCalls, 1);

  const timedOut = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    client: fakeClient(),
    pollIntervalMs: 0,
    taskTimeoutMs: 0,
  });
  assert.equal(timedOut.kind, 'fallback');
  assert.equal(timedOut.reason, 'timeout');
});

test('合并函数拒绝非 PDF 与页数不一致，并且不修改输入', () => {
  const baseline = paper();
  const before = structuredClone(baseline);
  const mismatched = result();
  mismatched.document.pageCount = 1;
  assert.throws(() => mergeMineruResult(baseline, mismatched));
  assert.deepEqual(baseline, before);
  assert.throws(() => mergeMineruResult({ ...baseline, source: 'arxiv' }, result()));
});

async function runWithStatuses(statuses) {
  const baseline = paper();
  const outcome = await enhancePdfFormulas({
    baseline,
    pdfBytes: pdfBytes(),
    settings: enabledSettings(),
    client: fakeClient({ statuses }),
    pollIntervalMs: 0,
  });
  assert.equal(outcome.paper, baseline);
  return outcome;
}

function fakeClient({ statuses = [], healthError, createError, onCall, onCancel } = {}) {
  let index = 0;
  return {
    async getHealth() {
      onCall?.('health');
      if (healthError) throw healthError;
      return health();
    },
    async createJob() {
      onCall?.('create');
      if (createError) throw createError;
      return queuedStatus();
    },
    async getJob() {
      onCall?.('get');
      return statuses[Math.min(index++, statuses.length - 1)] ?? runningStatus('parsing');
    },
    async cancelJob() {
      onCancel?.();
      return { ...queuedStatus(), state: 'cancelled', stage: 'cancelled' };
    },
  };
}

function health() {
  return {
    schemaVersion: 1,
    service: 'paperlens-mineru',
    serviceVersion: '0.1.0',
    status: 'ready',
    engine: { name: 'mineru', version: '3.4.4', backend: 'pipeline' },
    limits: {
      maxPdfBytes: 209715200,
      maxPdfPages: 500,
      maxConcurrentJobs: 1,
      taskTimeoutSeconds: 1800,
      resultTtlSeconds: 86400,
    },
    capabilities: {
      displayFormulas: true,
      inlineFormulaCount: true,
      crops: true,
      truthfulPageProgress: false,
    },
  };
}

function paper() {
  return {
    arxivId: '',
    url: 'pdf:upload:key',
    kind: 'html',
    title: 'Paper title',
    authors: [],
    categories: [],
    abstract: 'abstract',
    sections: [{
      level: 1,
      heading: 'Methods',
      paragraphs: ['body'],
      formulaIds: [9],
      children: [{
        level: 2,
        heading: 'Attention',
        paragraphs: ['detail'],
        formulaIds: [10],
        children: [],
      }],
    }],
    formulas: [{ id: 9, latex: 'fragment', display: true }],
    references: [],
    extractedAt: 1,
    warnings: [],
    source: 'pdf',
    formulaSupport: 'heuristic',
    pageCount: 4,
  };
}

function result() {
  return {
    schemaVersion: 1,
    jobId: 'job_safe',
    engine: { name: 'mineru', version: '3.4.4', backend: 'pipeline' },
    document: { pageCount: 4, displayFormulaCount: 2, inlineFormulaCount: 42 },
    formulas: [
      {
        id: 'formula_1',
        latex: 'a=b',
        page: 2,
        bbox: [100, 200, 300, 400],
        cropId: 'crop_1',
        sectionPath: 'Paper title > Methods > Attention',
        context: 'context one',
      },
      {
        id: 'formula_2',
        latex: 'c=d',
        page: 3,
        bbox: [110, 210, 310, 410],
        cropId: 'crop_2',
        sectionPath: 'Paper title > Unknown',
        context: 'context two',
      },
    ],
    warnings: [],
  };
}

function queuedStatus() {
  return {
    schemaVersion: 1,
    jobId: 'job_safe',
    state: 'queued',
    stage: 'queued',
    stageStartedAt: '2026-07-21T00:00:00Z',
    elapsedMs: 0,
    queuePosition: 0,
  };
}

function runningStatus(stage) {
  return { ...queuedStatus(), state: 'running', stage, elapsedMs: 10 };
}

function completedStatus(jobResult) {
  return { ...queuedStatus(), state: 'completed', stage: 'completed', elapsedMs: 20, result: jobResult };
}

function failedStatus(code) {
  return {
    ...queuedStatus(),
    state: 'failed',
    stage: 'failed',
    error: { code, message: 'failed' },
  };
}

function enabledSettings() {
  return { enabled: true, port: 17860, accessToken: 'test-token-value-that-is-long-enough-123456' };
}

function pdfBytes() {
  return new TextEncoder().encode('%PDF-1.4\n%%EOF').buffer;
}
