import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadPageCache,
  loadTabDocumentBinding,
  normalizePageCacheKey,
  savePageCache,
  saveTabDocumentBinding,
} from '../src/storage/cache.ts';

function installSessionStorage(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  let quotaFailures = options.quotaFailures ?? 0;

  globalThis.chrome = {
    storage: {
      session: {
        async get(key) {
          if (key == null) return Object.fromEntries(values);
          if (typeof key === 'string') {
            return values.has(key) ? { [key]: values.get(key) } : {};
          }
          throw new Error('测试存储只实现当前用到的 get 形式');
        },
        async set(input) {
          const [key, value] = Object.entries(input)[0];
          writes.push(value);
          await options.beforeSet?.(value, writes.length);
          if (quotaFailures > 0) {
            quotaFailures -= 1;
            throw new Error('QUOTA_BYTES quota exceeded');
          }
          values.set(key, structuredClone(value));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
        },
      },
    },
  };

  return { values, writes };
}

function cache(savedAt, formulaSupport = 'heuristic') {
  return {
    paper: {
      url: 'https://arxiv.org/pdf/1706.03762',
      formulaSupport,
      formulas: formulaSupport === 'ocr' ? [{ id: 1, latex: 'x', display: true }] : [],
    },
    summary: null,
    derivations: {},
    savedAt,
  };
}

test('缓存身份忽略 URL hash，但保留查询参数和上传 PDF 哈希键', () => {
  assert.equal(
    normalizePageCacheKey('https://example.com/paper.pdf?download=1#page=8'),
    'https://example.com/paper.pdf?download=1',
  );
  assert.equal(
    normalizePageCacheKey('pdf:attention.pdf:1234:abcdef'),
    'pdf:attention.pdf:1234:abcdef',
  );
});

test('同一文档写入严格串行，读取会等待最新 MinerU OCR 结果', async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  installSessionStorage({}, {
    beforeSet: async (_value, index) => {
      if (index === 1) await firstBlocked;
    },
  });

  const url = 'https://arxiv.org/pdf/1706.03762#page=1';
  const baselineWrite = savePageCache(url, cache(1));
  const enhancedWrite = savePageCache(
    'https://arxiv.org/pdf/1706.03762#page=9',
    cache(2, 'ocr'),
  );
  const pendingRead = loadPageCache(url);

  releaseFirst();
  assert.equal(await baselineWrite, true);
  assert.equal(await enhancedWrite, true);
  assert.equal((await pendingRead)?.paper?.formulaSupport, 'ocr');
});

test('上传 PDF 绑定可按 tab 恢复，底层页面变化后自动失效', async () => {
  installSessionStorage();
  const binding = {
    documentKey: 'pdf:attention.pdf:1234:abcdef',
    sourceTabUrl: 'chrome-extension://paperlens/sidepanel.html',
    title: 'attention.pdf',
  };

  assert.equal(await saveTabDocumentBinding(42, binding), true);
  assert.deepEqual(
    await loadTabDocumentBinding(42, 'chrome-extension://paperlens/sidepanel.html'),
    binding,
  );
  assert.equal(
    await loadTabDocumentBinding(42, 'https://arxiv.org/abs/1706.03762'),
    null,
  );
  assert.equal(
    await loadTabDocumentBinding(42, 'chrome-extension://paperlens/sidepanel.html'),
    null,
  );
});

test('容量不足时淘汰最旧页面缓存并重试当前写入', async () => {
  const oldestKey = 'paperlens.cache:https://example.com/old.pdf';
  const newerKey = 'paperlens.cache:https://example.com/newer.pdf';
  const storage = installSessionStorage({
    [oldestKey]: cache(1),
    [newerKey]: cache(2),
  }, { quotaFailures: 1 });

  assert.equal(
    await savePageCache('https://example.com/current.pdf', cache(3, 'ocr')),
    true,
  );
  assert.equal(storage.values.has(oldestKey), false);
  assert.equal(
    storage.values.get('paperlens.cache:https://example.com/current.pdf')?.paper?.formulaSupport,
    'ocr',
  );
});

test('当前条目仍无法写入时返回 false，不伪装成已保存', async () => {
  installSessionStorage({}, { quotaFailures: 2 });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      await savePageCache('https://example.com/too-large.pdf', cache(1, 'ocr')),
      false,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test.after(() => {
  delete globalThis.chrome;
});
