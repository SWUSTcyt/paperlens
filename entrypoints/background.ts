// PaperLens Service Worker 入口
// 职责：
// 1. 点击扩展图标 => 打开侧边栏
// 2. 注册 LLM Port 处理器（所有 LLM 调用的唯一出口，Key 不会离开 Service Worker）

import { installLlmPortHandler } from '../src/llm/bgHandler';

export default defineBackground(() => {
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      console.warn('[PaperLens] 初始化 sidePanel 行为失败：', err);
    });

  installLlmPortHandler();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PING') {
      sendResponse({ ok: true, ts: Date.now() });
      return true;
    }
    return false;
  });
});
