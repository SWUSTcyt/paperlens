import { defineConfig } from 'wxt';

// PaperLens WXT 配置
// 参考文档：https://wxt.dev/api/config.html
export default defineConfig({
  // 源码根目录（entrypoints/ 所在目录）
  srcDir: '.',

  // 启用 React 模块，自动处理 JSX / HMR / 依赖
  modules: ['@wxt-dev/module-react'],

  // 扩展展示名与全局默认 manifest 片段
  manifest: {
    name: 'PaperLens',
    short_name: 'PaperLens',
    description: 'PaperLens：在 arXiv 页面一键生成论文解读与公式推导，并导出为 Markdown。',
    // 权限按需最小化
    permissions: [
      'sidePanel',
      'storage',
      'activeTab',
      'scripting',
      'downloads',
      'tabs',
    ],
    // 允许访问 arXiv + 各 LLM Provider API 域名
    host_permissions: [
      '*://*.arxiv.org/*',
      '*://ar5iv.labs.arxiv.org/*',
      '*://ar5iv.org/*',
      // LLM Providers（Service Worker 需要在此白名单内才能不受 CORS 限制地发请求）
      'https://dashscope.aliyuncs.com/*',
      'https://api.deepseek.com/*',
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
    ],
    // 点击扩展图标时，Service Worker 会将其切换为打开 SidePanel
    action: {
      default_title: 'PaperLens',
    },
    // Content Security Policy：允许 LLM Provider 接口（在 Service Worker 中调用即可，无需放开 CSP）
  },
});
