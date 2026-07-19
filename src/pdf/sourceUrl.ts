/** PDF 摄入来源的纯函数工具；保持与 Chrome API、pdf.js 解耦，便于离线回归。 */

export type PdfUrlKind = 'arxiv' | 'remote' | 'local' | 'none';

function looksLikePdfName(value: string): boolean {
  const clean = value.split(/[?#]/, 1)[0].trim();
  try {
    return decodeURIComponent(clean).toLowerCase().endsWith('.pdf');
  } catch {
    return clean.toLowerCase().endsWith('.pdf');
  }
}

/** 根据 URL 与浏览器标签标题识别 PDF 来源。标题用于覆盖无 `.pdf` 后缀的下载地址。 */
export function classifyPdfUrl(url: string, tabTitle = ''): PdfUrlKind {
  try {
    const parsed = new URL(url);
    const titleLooksPdf = looksLikePdfName(tabTitle);
    const pathLooksPdf = looksLikePdfName(parsed.pathname);

    if (parsed.protocol === 'file:') {
      return pathLooksPdf || titleLooksPdf ? 'local' : 'none';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'none';

    const host = parsed.hostname.toLowerCase();
    const isArxiv = host === 'arxiv.org' || host.endsWith('.arxiv.org');
    if (isArxiv) {
      return /^\/pdf(?:\/|$)/i.test(parsed.pathname) || pathLooksPdf ? 'arxiv' : 'none';
    }
    return pathLooksPdf || titleLooksPdf ? 'remote' : 'none';
  } catch {
    return 'none';
  }
}

/** Chrome 可选 host permission 的最小主机匹配模式（端口不属于 match pattern）。 */
export function permissionPatternForPdfUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

/** 在交给 pdf.js 前做轻量签名校验，避免把登录页或错误页当成 PDF 解析。 */
export function assertPdfBytes(data: ArrayBuffer): void {
  if (data.byteLength === 0) throw new Error('PDF 文件为空。');
  const prefix = new Uint8Array(data, 0, Math.min(data.byteLength, 1024));
  const signature = new TextDecoder('latin1').decode(prefix);
  if (!signature.includes('%PDF-')) {
    throw new Error('获取到的内容不是有效的 PDF；可能是登录页、下载拦截页或损坏文件。');
  }
}

/** 下载并验签 PDF；把 HTTP 错误页和登录页挡在 pdf.js 之前。 */
export async function downloadPdfBytes(
  url: string,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<ArrayBuffer> {
  const response = await fetcher(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`下载 PDF 失败：HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  assertPdfBytes(data);
  return data;
}

/** 上传 PDF 的稳定缓存键；只保存摘要，不把原始二进制写入 storage。 */
export async function buildUploadCacheKey(
  filename: string,
  size: number,
  data: ArrayBuffer,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
  const safeName = filename.trim().replace(/:/g, '%3A') || 'unnamed.pdf';
  return `pdf:${safeName}:${size}:${hash}`;
}
