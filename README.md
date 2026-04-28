# PaperLens

一款专注 arXiv 的 Chrome 扩展：在打开论文页面时一键生成**论文解读**、**公式逐步推导**，并**导出为 Markdown** 文件。

## 特性

- **论文解读**：结构化总结研究问题 / 方法 / 主要贡献 / 实验与结果 / 结论；长论文自动 Map-Reduce 压缩，支持简洁 / 详细两档粒度。
- **公式逐步推导**：从定义开始逐步推导，符号拆解 + 关键运算解析 + 小例子三段式；点击「回跳原文」可在原页面高亮公式出处。
- **Markdown 导出**：一键保存为 `.md` 文件，含 YAML front-matter（适合 Obsidian / Typora），公式保留 `$$...$$` 语法。
- **BYOK（Bring Your Own Key）**：支持 **Qwen（DashScope 兼容模式）/ DeepSeek / OpenAI / Anthropic** 四家 LLM，API Key 仅存本地；支持为"解读 / 推导"分别绑定不同模型（例如推导用 `deepseek-reasoner`）。
- **流式渲染**：所有 LLM 调用走 SSE 流式，SidePanel 边生成边显示。
- **公式渲染**：KaTeX 完整离线字体打包，不依赖外网 CDN。

## 技术栈

- [WXT](https://wxt.dev/) + React 19 + TypeScript
- Tailwind CSS v3
- Chrome Manifest V3（SidePanel API）
- Markdown：`marked` + `DOMPurify`
- 公式：`katex`
- 可选后续：`tiktoken`（更精确的 token 计数）

## 快速开始

### 环境要求

- Node.js ≥ 18（建议 22+）
- pnpm 10+

### 开发/构建

```bash
pnpm install          # 安装依赖（会触发 wxt prepare）
pnpm dev              # 开发模式，自动打开 Chrome 并加载扩展（HMR）
pnpm build            # 生产构建，产物在 .output/chrome-mv3/
pnpm compile          # 仅做 tsc 类型检查（不产出）
pnpm zip              # 打 zip 包以上架 Chrome Web Store
```

### 手动加载扩展

1. 执行 `pnpm build`
2. 打开 Chrome → `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3/` 目录
5. 打开任一 arXiv 论文页，例如：
   - 摘要页：<https://arxiv.org/abs/2310.06825>
   - HTML 全文：<https://arxiv.org/html/2310.06825>
   - ar5iv：<https://ar5iv.labs.arxiv.org/html/2310.06825>
6. 点击工具栏的 PaperLens 图标 → SidePanel 打开
7. 首次使用请先点底部「设置 / 配置 API Key」，填入至少一家 LLM 的 Key 并「测试连接」

### 典型使用流

1. 在 arXiv 论文页打开 PaperLens SidePanel
2. 点顶部「抽取本页」—— 几秒内完成 DOM → `PaperContent` 抽取（标题、作者、章节、公式、参考文献）
3. 「论文解读」Tab → 选择粒度 → 点「生成解读」
4. 「公式推导」Tab → 从列表中选中任意公式 → 点「生成推导」，必要时用「回跳原文」按钮在页面定位
5. 「导出 Markdown」Tab → 选「导出 .md（选择位置）」或「直接保存到下载目录」

## 目录结构

```
.
├── entrypoints/                     # WXT 入口（扩展各组件）
│   ├── background.ts                # Service Worker：LLM Port 路由 + 生命周期
│   ├── content.ts                   # Content Script：arXiv 页抽取 + 回跳滚动
│   ├── sidepanel/                   # SidePanel UI（React）
│   │   ├── App.tsx
│   │   ├── tabs/
│   │   │   ├── SummaryTab.tsx       # 论文解读 Tab（流式）
│   │   │   ├── DerivationTab.tsx    # 公式推导 Tab（列表 + 详情）
│   │   │   └── ExportTab.tsx        # 导出 Tab（预览 + 下载）
│   │   └── style.css
│   └── options/                     # BYOK 设置页
│       ├── Options.tsx
│       └── ...
├── src/                             # 业务代码
│   ├── extractors/                  # arXiv 页面抽取（abs / latexml）
│   ├── formula/                     # <math> 抽取 + Markdown ↔ KaTeX 桥
│   ├── llm/                         # LLM Provider 抽象与实现
│   │   ├── providers/
│   │   │   ├── qwen.ts
│   │   │   ├── deepseek.ts
│   │   │   ├── openai.ts
│   │   │   ├── anthropic.ts
│   │   │   └── openaiCompatible.ts
│   │   ├── protocol.ts              # SidePanel ↔ Background 的 Port 协议
│   │   ├── bgHandler.ts             # Service Worker 侧 LLM 流转
│   │   ├── retry.ts                 # 429/5xx 自动重试（仅首次响应前）
│   │   └── sse.ts                   # SSE 行迭代器
│   ├── bridge/                      # SidePanel → Content / Background 桥
│   ├── pipelines/                   # summarize / derive 流水线
│   ├── prompts/                     # Prompt 模板
│   ├── storage/                     # chrome.storage 封装 + 任务绑定
│   ├── export/                      # Markdown 模板 + 下载封装
│   ├── components/                  # 通用 UI 组件（MarkdownView）
│   └── util/                        # 通用工具（token 估计等）
├── docs/                            # 开发笔记
├── wxt.config.ts
├── tailwind.config.js
├── postcss.config.js
└── tsconfig.json
```

## 里程碑

- [x] M0 环境搭建（WXT + React + TS + Tailwind，空侧边栏在 arXiv 页弹出）
- [x] M1 arXiv 抽取器（abs / html / ar5iv 三种页面统一结构化输出）
- [x] M2 BYOK + LLM Provider（Qwen / DeepSeek / OpenAI / Anthropic）+ Options 页
- [x] M3 论文解读全链路（Map-Reduce、结构化 Markdown、SidePanel 流式）
- [x] M4 公式逐步推导（公式列表 + 推导 Prompt + KaTeX 渲染 + 锚点回跳）
- [x] M5 Markdown 导出（YAML front-matter + `chrome.downloads`）
- [x] M6 打磨（错误处理、429/5xx 重试、空态、README）
- [ ] M7 沉淀 Cursor Skill：`browser-extension-dev` + `git-push-flow`

### 待办（欢迎 PR）

- **图标**：当前未提供 PNG 图标，Chrome 会使用默认灰图标。替换方案：把 16/32/48/128 像素的 PNG 放到 `public/icon/`。
- **KaTeX 字体瘦身**：默认打包了 Main/AMS/Caligraphic/Fraktur 等全部字形，可按需剔除仅保留 Main+AMS。
- **多论文对比**：目前只解读"当前活动 Tab"，后续可以沉淀历史。

## 隐私

- 所有 LLM API Key 仅存于 `chrome.storage.local`，只在扩展的 Service Worker 中使用，不随任何页面注入。
- 没有任何遥测或云端同步，导出和解读均为本地操作。
- 仅在你主动访问的 arXiv / ar5iv 页面生效（`host_permissions` 白名单内）。
- 发往 LLM 的是论文的**结构化文本**（不含完整 PDF），且只在你显式点击「生成解读 / 生成推导 / 测试连接」时发送。

## 许可

MIT
