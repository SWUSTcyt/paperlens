// SidePanel 与 Content Script 的抽取桥
// 统一封装 "向当前活动 Tab 请求抽取 PaperContent" 这一动作，
// 使得 UI 层不用关心 chrome.tabs / chrome.runtime 的细节。

import type { PaperContent } from '../extractors/types';

interface BridgeResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 向当前活动 Tab 的 Content Script 发送 EXTRACT_PAPER 请求。
 * 如果目标页不是 arXiv 或 Content Script 未就绪，会抛出可读的错误。
 */
export async function requestExtractFromActiveTab(): Promise<PaperContent> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('找不到当前活动标签页');
  }

  let response: BridgeResponse<PaperContent> | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tab.id, {
      type: 'EXTRACT_PAPER',
    })) as BridgeResponse<PaperContent> | undefined;
  } catch (err) {
    // 常见原因：当前 Tab 不是 arXiv 页（Content Script 未注入）
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `无法与页面通信：${msg}。请先在 arXiv 页面打开 PaperLens。`,
    );
  }

  if (!response) {
    throw new Error('Content Script 未响应，请刷新页面后再试。');
  }
  if (!response.ok || !response.data) {
    throw new Error(response.error || '抽取失败');
  }
  return response.data;
}

/**
 * 向当前活动 Tab 发送 SCROLL_TO_FORMULA 请求，要求 Content Script 滚动到指定公式并高亮。
 */
export async function requestScrollToFormula(formulaId: number): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('找不到当前活动标签页');
  }

  let response: BridgeResponse<unknown> | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tab.id, {
      type: 'SCROLL_TO_FORMULA',
      formulaId,
    })) as BridgeResponse<unknown> | undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法与页面通信：${msg}`);
  }

  if (!response) {
    throw new Error('Content Script 未响应，请刷新页面后再试。');
  }
  if (!response.ok) {
    throw new Error(response.error || '回跳失败');
  }
}
