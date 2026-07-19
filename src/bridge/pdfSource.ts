// PDF 来源桥：识别「当前标签页是否为可解析的 PDF」并获取其字节
//
// 甜点场景（MVP）：arXiv 的 /pdf/ 链接。
//   - host_permissions 已含 *://*.arxiv.org/*，SidePanel 可直接 fetch，无需新权限。
//   - PDF 继续显示在标签页里，解析结果在侧边栏 → 天然并排阅读。
// 后续可扩展到任意在线 PDF（按需申请 optional_host_permissions）与本地文件上传。

import type { PaperContent } from '../extractors/types';
import { extractPdf } from '../pdf/extractPdf';

/** 判断一个 URL 是否为「当前可解析」的 PDF（MVP 仅放行 arXiv /pdf/） */
export function detectPdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const isArxiv = u.hostname.endsWith('arxiv.org');
    if (isArxiv && /^\/pdf\//.test(u.pathname)) return true;
    // 兼容以 .pdf 结尾的 arXiv 链接
    if (isArxiv && /\.pdf$/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 从当前活动标签页的 PDF 地址抓取字节并解析为 PaperContent。
 * 由 SidePanel 侧发起（拥有 arXiv 的 host 权限，绕过页面 CORS）。
 */
export async function extractPdfFromActiveTab(): Promise<PaperContent> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  if (!url || !detectPdfUrl(url)) {
    throw new Error('当前标签页不是可解析的 PDF（目前支持 arXiv 的 /pdf/ 链接）。');
  }

  let buffer: ArrayBuffer;
  try {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) {
      throw new Error(`下载 PDF 失败：HTTP ${resp.status}`);
    }
    buffer = await resp.arrayBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`获取 PDF 失败：${msg}`);
  }

  if (buffer.byteLength === 0) {
    throw new Error('下载到的 PDF 为空。');
  }

  return extractPdf(buffer, url);
}
