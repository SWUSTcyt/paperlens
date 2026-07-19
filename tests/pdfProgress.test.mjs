import assert from 'node:assert/strict';
import test from 'node:test';

import { reportPdfPageProgress } from '../src/pdf/progress.ts';

test('分页进度逐页报告，并按配置让出主线程', async () => {
  const reported = [];
  let yielded = 0;
  const options = {
    yieldEveryPages: 2,
    onProgress: (progress) => reported.push(progress),
    yieldTask: async () => {
      yielded += 1;
    },
  };
  for (let page = 1; page <= 5; page++) {
    await reportPdfPageProgress(page, 5, options);
  }
  assert.deepEqual(reported.map((progress) => progress.currentPage), [1, 2, 3, 4, 5]);
  assert.ok(reported.every((progress) => progress.totalPages === 5));
  assert.equal(yielded, 3);
});
