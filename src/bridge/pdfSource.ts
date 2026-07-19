// PDF 来源桥：识别「当前标签页是否为可解析的 PDF」并获取其字节
//
// arXiv 复用常驻 host permission；其他在线 PDF 仅在用户点击解析时申请当前主机权限。
// file:// 由 Chrome 的「允许访问文件网址」开关控制，关闭时给出可操作提示。

import type { PaperContent } from '../extractors/types';
import { extractPdf, type ExtractPdfOptions } from '../pdf/extractPdf';
import {
  ensurePdfSourceAccess,
  PdfSourceError,
  type PdfAccessApi,
  type PdfSourceErrorCode,
} from '../pdf/sourceAccess';
import {
  classifyPdfUrl,
  downloadPdfBytes,
  permissionPatternForPdfUrl,
} from '../pdf/sourceUrl';

export { PdfSourceError, type PdfSourceErrorCode } from '../pdf/sourceAccess';

/** 判断一个 URL 是否为可解析的 PDF；标题可覆盖无扩展名的下载地址。 */
export function detectPdfUrl(url: string, tabTitle = ''): boolean {
  return classifyPdfUrl(url, tabTitle) !== 'none';
}

const chromePdfAccessApi: PdfAccessApi = {
  isFileAccessAllowed: () =>
    new Promise((resolve) => chrome.extension.isAllowedFileSchemeAccess(resolve)),
  requestOrigin: (origin) =>
    new Promise((resolve, reject) => {
      chrome.permissions.request({ origins: [origin] }, (allowed) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(allowed);
      });
    }),
};

/**
 * 从当前活动标签页的 PDF 地址抓取字节并解析为 PaperContent。
 * 由 SidePanel 侧发起（拥有 arXiv 的 host 权限，绕过页面 CORS）。
 */
export async function extractPdfFromActiveTab(
  options: ExtractPdfOptions = {},
): Promise<PaperContent> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return extractPdfFromUrl(tab?.url ?? '', tab?.title ?? '', options);
}

/** 从已知标签 URL 解析；由点击处理器直接调用，确保权限请求保留用户手势。 */
export async function extractPdfFromUrl(
  url: string,
  tabTitle = '',
  options: ExtractPdfOptions = {},
): Promise<PaperContent> {
  const kind = classifyPdfUrl(url, tabTitle);
  if (!url || kind === 'none') {
    throw new PdfSourceError('当前标签页不是可识别的 PDF。', 'not-pdf');
  }

  await ensurePdfSourceAccess(kind, permissionPatternForPdfUrl(url), chromePdfAccessApi);

  let buffer: ArrayBuffer;
  try {
    buffer = await downloadPdfBytes(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`获取 PDF 失败：${msg}`);
  }

  return extractPdf(buffer, url, options);
}

/** 打开当前扩展的详情页，供用户开启「允许访问文件网址」。 */
export async function openFileAccessSettings(): Promise<void> {
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}
