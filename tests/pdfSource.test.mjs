import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPdfBytes,
  buildUploadCacheKey,
  classifyPdfUrl,
  permissionPatternForPdfUrl,
} from '../src/pdf/sourceUrl.ts';

test('classifyPdfUrl 识别 arXiv、任意在线与本地 PDF', () => {
  assert.equal(classifyPdfUrl('https://arxiv.org/pdf/2310.06825'), 'arxiv');
  assert.equal(classifyPdfUrl('https://papers.example.org/a/PAPER.PDF?download=1'), 'remote');
  assert.equal(classifyPdfUrl('https://papers.example.org/download/42', 'paper.pdf'), 'remote');
  assert.equal(classifyPdfUrl('file:///C:/papers/paper.pdf'), 'local');
});

test('classifyPdfUrl 不把普通网页或危险协议识别为 PDF', () => {
  assert.equal(classifyPdfUrl('https://example.org/article'), 'none');
  assert.equal(classifyPdfUrl('https://arxiv.org/abs/2310.06825', 'paper.pdf'), 'none');
  assert.equal(classifyPdfUrl('chrome://extensions/'), 'none');
  assert.equal(classifyPdfUrl('not a url'), 'none');
});

test('permissionPatternForPdfUrl 只返回当前 HTTP(S) 主机范围', () => {
  assert.equal(
    permissionPatternForPdfUrl('https://papers.example.org:8443/paper.pdf'),
    'https://papers.example.org/*',
  );
  assert.equal(permissionPatternForPdfUrl('file:///C:/paper.pdf'), null);
});

test('assertPdfBytes 接受 PDF 签名并拒绝空文件和 HTML', () => {
  const valid = new TextEncoder().encode('%PDF-1.7\nbody').buffer;
  assert.doesNotThrow(() => assertPdfBytes(valid));
  assert.throws(() => assertPdfBytes(new ArrayBuffer(0)), /为空/);
  assert.throws(
    () => assertPdfBytes(new TextEncoder().encode('<html>login</html>').buffer),
    /有效的 PDF/,
  );
});

test('buildUploadCacheKey 对同一文件稳定并区分内容', async () => {
  const a = new TextEncoder().encode('%PDF-1.7\nA').buffer;
  const b = new TextEncoder().encode('%PDF-1.7\nB').buffer;
  const key1 = await buildUploadCacheKey('paper.pdf', a.byteLength, a);
  const key2 = await buildUploadCacheKey('paper.pdf', a.byteLength, a);
  const key3 = await buildUploadCacheKey('paper.pdf', b.byteLength, b);
  assert.equal(key1, key2);
  assert.match(key1, /^pdf:paper\.pdf:\d+:[a-f0-9]{16}$/);
  assert.notEqual(key1, key3);
});
