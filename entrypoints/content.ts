// PaperLens Content Script
// 职责：
// 1. 页面加载完毕时向 Service Worker 发送 "PAGE_READY"，便于 SidePanel 感知
// 2. 监听 "EXTRACT_PAPER" 消息，同步调用 extractor 并返回 PaperContent

import { extractPaper, detectKind } from '../src/extractors/arxiv';
import type { PaperContent } from '../src/extractors/types';

export default defineContentScript({
  matches: [
    '*://arxiv.org/*',
    '*://*.arxiv.org/*',
    '*://ar5iv.labs.arxiv.org/*',
    '*://ar5iv.org/*',
  ],
  runAt: 'document_idle',
  main() {
    const kind = detectKind(location.href);
    if (!kind) return;

    // 1. 页面就绪通知
    chrome.runtime
      .sendMessage({
        type: 'PAGE_READY',
        payload: {
          kind,
          url: location.href,
          title: document.title,
        },
      })
      .catch(() => {
        // Service Worker 尚未激活；SidePanel 打开后会主动拉取
      });

    // 2. 监听抽取请求 + 回跳请求
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      // 2.1 抽取本页
      if (message?.type === 'EXTRACT_PAPER') {
        try {
          const paper: PaperContent = extractPaper(document, location.href);
          sendResponse({ ok: true, data: paper });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      // 2.2 回跳到指定公式原文
      if (message?.type === 'SCROLL_TO_FORMULA') {
        const fid = message.formulaId;
        try {
          const el = document.querySelector(`[data-pl-fid="${fid}"]`) as HTMLElement | null;
          if (!el) {
            sendResponse({
              ok: false,
              error: '未在原文中找到对应公式。请先在 SidePanel 点"抽取本页"。',
            });
            return true;
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          highlightMomentarily(el);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      return false;
    });
  },
});

/** 在目标节点周围短暂叠加一层高亮框，便于用户视线快速捕获 */
function highlightMomentarily(el: HTMLElement) {
  const origOutline = el.style.outline;
  const origTransition = el.style.transition;
  const origBg = el.style.backgroundColor;
  el.style.transition = 'outline-color 0.3s, background-color 0.3s';
  el.style.outline = '2px solid #5f73f2';
  el.style.backgroundColor = 'rgba(95, 115, 242, 0.15)';
  window.setTimeout(() => {
    el.style.outline = origOutline;
    el.style.backgroundColor = origBg;
    el.style.transition = origTransition;
  }, 1600);
}
