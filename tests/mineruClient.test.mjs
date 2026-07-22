import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MineruClient,
  MineruClientError,
  buildMineruBaseUrl,
  parseHealth,
  parseJobStatus,
} from '../src/mineru/client.ts';
import { normalizeMineruSettings } from '../src/mineru/settings.ts';

const TOKEN = 'test-token-value-that-is-long-enough-123456';

test('本地地址只能由 127.0.0.1 和合法端口构造', () => {
  assert.equal(buildMineruBaseUrl(17860), 'http://127.0.0.1:17860');
  for (const port of [0, 1023, 65536, 1.5, Number.NaN]) {
    assert.throws(() => buildMineruBaseUrl(port), errorCode('CONFIG_INVALID'));
  }
  assert.throws(() => new MineruClient({ port: 17860, accessToken: 'short' }), errorCode('CONFIG_INVALID'));
});

test('设置默认关闭并兼容旧缓存或非法端口', () => {
  assert.deepEqual(normalizeMineruSettings(), { enabled: false, port: 17860, accessToken: '' });
  assert.deepEqual(normalizeMineruSettings({ enabled: true, port: 17861, accessToken: TOKEN }), {
    enabled: true,
    port: 17861,
    accessToken: TOKEN,
  });
  assert.deepEqual(normalizeMineruSettings({ enabled: true, port: 80, accessToken: TOKEN }), {
    enabled: true,
    port: 17860,
    accessToken: TOKEN,
  });
});

test('健康检查严格校验 schema、引擎和冻结能力', async () => {
  let request;
  const client = new MineruClient({
    port: 17860,
    accessToken: TOKEN,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse(health());
    },
  });
  const result = await client.getHealth();
  assert.equal(result.engine.version, '3.4.4');
  assert.equal(request.url, 'http://127.0.0.1:17860/v1/health');
  assert.equal(new Headers(request.init.headers).has('Authorization'), false);

  assert.throws(() => parseHealth({ ...health(), schemaVersion: 2 }), errorCode('VERSION_INCOMPATIBLE'));
  assert.throws(() => parseHealth({ ...health(), unexpected: true }), errorCode('INVALID_RESPONSE'));
  assert.throws(
    () => parseHealth({ ...health(), engine: { name: 'mineru', version: '3.5.0', backend: 'pipeline' } }),
    errorCode('VERSION_INCOMPATIBLE'),
  );
});

test('浏览器原生 fetch 以 globalThis 为接收者调用', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function browserLikeFetch() {
    assert.equal(this, globalThis);
    return jsonResponse(health());
  };
  try {
    const client = new MineruClient({ port: 17860, accessToken: TOKEN });
    assert.equal((await client.getHealth()).status, 'ready');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('连接测试必须同时通过健康检查和 bearer 鉴权探针', async () => {
  const requests = [];
  const client = new MineruClient({
    port: 17860,
    accessToken: TOKEN,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (String(url).endsWith('/v1/health')) return jsonResponse(health());
      return jsonResponse(serviceError('JOB_NOT_FOUND', 'missing'), 404);
    },
  });
  const result = await client.testConnection();
  assert.equal(result.status, 'ready');
  const probeHeaders = new Headers(requests[1].init.headers);
  assert.equal(probeHeaders.get('Authorization'), `Bearer ${TOKEN}`);
  assert.equal(probeHeaders.get('X-PaperLens-Schema-Version'), '1');
  assert.equal(requests[1].url, 'http://127.0.0.1:17860/v1/jobs/job_paperlens_connection_probe');
});

test('401、网络错误、取消和超时映射稳定且不泄露 token', async () => {
  const unauthorized = new MineruClient({
    port: 17860,
    accessToken: TOKEN,
    fetchImpl: async (url) => String(url).endsWith('/health')
      ? jsonResponse(health())
      : jsonResponse(serviceError('AUTH_INVALID', TOKEN), 401),
  });
  await assert.rejects(() => unauthorized.testConnection(), errorCode('AUTH_FAILED'));

  const disconnected = new MineruClient({
    port: 17860,
    accessToken: TOKEN,
    fetchImpl: async () => { throw new TypeError(`connect ${TOKEN}`); },
  });
  await assert.rejects(() => disconnected.getHealth(), errorCode('CONNECTION_FAILED'));

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(() => disconnected.getHealth(abortController.signal), errorCode('ABORTED'));

  const timeoutClient = new MineruClient({
    port: 17860,
    accessToken: TOKEN,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  await assert.rejects(() => timeoutClient.getHealth(), errorCode('TIMEOUT'));

  for (const client of [unauthorized, disconnected, timeoutClient]) {
    try {
      await client.testConnection();
    } catch (error) {
      assert.equal(String(error).includes(TOKEN), false);
    }
  }
});

test('完成状态接受 0 展示公式，但拒绝半份或越界结果', () => {
  const valid = completedStatus();
  assert.equal(parseJobStatus(valid).result.document.displayFormulaCount, 0);
  const { result: _missing, ...withoutResult } = valid;
  assert.throws(() => parseJobStatus(withoutResult), errorCode('INVALID_RESPONSE'));
  assert.throws(
    () => parseJobStatus({ ...valid, result: { ...valid.result, jobId: 'job_other' } }),
    errorCode('INVALID_RESPONSE'),
  );
  assert.throws(
    () => parseJobStatus({
      ...valid,
      result: {
        ...valid.result,
        document: { ...valid.result.document, displayFormulaCount: 1 },
      },
    }),
    errorCode('INVALID_RESPONSE'),
  );
  assert.throws(
    () => parseJobStatus({
      ...valid,
      result: {
        ...valid.result,
        document: { ...valid.result.document, displayFormulaCount: 1 },
        formulas: [{ id: 'f1', latex: 'x', page: 1, bbox: [-1, 2, 3, 4] }],
      },
    }),
    errorCode('INVALID_RESPONSE'),
  );
});

test('裁剪图只接受受控 ID、鉴权请求和允许的图片 MIME', async () => {
  let request;
  const client = new MineruClient({
    port: 17860,
    accessToken: TOKEN,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png', 'content-length': '3' },
      });
    },
  });
  const crop = await client.getCrop('job_safe', 'crop_safe');
  assert.equal(crop.size, 3);
  assert.equal(request.url, 'http://127.0.0.1:17860/v1/jobs/job_safe/crops/crop_safe');
  assert.equal(new Headers(request.init.headers).get('Authorization'), `Bearer ${TOKEN}`);
  await assert.rejects(() => client.getCrop('../job', 'crop_safe'), errorCode('CONFIG_INVALID'));

  const badMime = new MineruClient({
    port: 17860,
    accessToken: TOKEN,
    fetchImpl: async () => new Response('html', { headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(() => badMime.getCrop('job_safe', 'crop_safe'), errorCode('INVALID_RESPONSE'));
});

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

function completedStatus() {
  return {
    schemaVersion: 1,
    jobId: 'job_safe',
    state: 'completed',
    stage: 'completed',
    stageStartedAt: '2026-07-21T00:00:00Z',
    elapsedMs: 100,
    result: {
      schemaVersion: 1,
      jobId: 'job_safe',
      engine: { name: 'mineru', version: '3.4.4', backend: 'pipeline' },
      document: { pageCount: 1, displayFormulaCount: 0, inlineFormulaCount: 58 },
      formulas: [],
      warnings: [],
    },
  };
}

function serviceError(code, message) {
  return { schemaVersion: 1, requestId: 'req_test', error: { code, message } };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorCode(code) {
  return (error) => error instanceof MineruClientError && error.code === code;
}
