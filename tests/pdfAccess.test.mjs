import assert from 'node:assert/strict';
import test from 'node:test';

import { ensurePdfSourceAccess, PdfSourceError } from '../src/pdf/sourceAccess.ts';
import { downloadPdfBytes } from '../src/pdf/sourceUrl.ts';

test('远程来源只请求当前 origin', async () => {
  const requested = [];
  const api = {
    isFileAccessAllowed: async () => true,
    requestOrigin: async (origin) => {
      requested.push(origin);
      return true;
    },
  };
  await ensurePdfSourceAccess('remote', 'https://papers.example.org/*', api);
  assert.deepEqual(requested, ['https://papers.example.org/*']);
});

test('远程权限拒绝与本地文件开关关闭返回可区分错误', async () => {
  const deniedApi = {
    isFileAccessAllowed: async () => false,
    requestOrigin: async () => false,
  };
  await assert.rejects(
    ensurePdfSourceAccess('remote', 'https://papers.example.org/*', deniedApi),
    (error) => error instanceof PdfSourceError && error.code === 'permission-denied',
  );
  await assert.rejects(
    ensurePdfSourceAccess('local', null, deniedApi),
    (error) => error instanceof PdfSourceError && error.code === 'file-access-disabled',
  );
});

test('下载链路接受 PDF，拒绝 HTTP 错误与伪 PDF', async () => {
  const valid = await downloadPdfBytes('https://example.org/paper.pdf', async () =>
    new Response('%PDF-1.7\nbody'),
  );
  assert.ok(valid.byteLength > 0);
  await assert.rejects(
    downloadPdfBytes('https://example.org/paper.pdf', async () => new Response('no', { status: 403 })),
    /HTTP 403/,
  );
  await assert.rejects(
    downloadPdfBytes('https://example.org/paper.pdf', async () => new Response('<html>login</html>')),
    /有效的 PDF/,
  );
});
