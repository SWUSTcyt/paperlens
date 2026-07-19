# PaperLens 架构参考（Handoff 文档）

> 目的：给任何接手者（含在 Codex/其他 IDE 中继续开发的自己）一份「项目当前是怎么运作的」权威参考。
> 阅读顺序建议：本文件 → `docs/plan-pdf-extraction.md`（下一个大功能方案）→ `docs/dev-notes.md`（时间线与踩坑）。
>
> 最后更新：2026-07（M0–M9：含 Phase B 任意在线、本地与上传 PDF）。

---

## 1. 一句话概述

PaperLens 是一个 Chrome Manifest V3 扩展，在 **arXiv 论文页**（`/abs`、`/html`、`ar5iv` 镜像，以及 **`/pdf/`**）上：

1. 把页面 DOM（或 PDF 字节）抽取成统一的 `PaperContent` 结构；
2. 走 BYOK 的 LLM（Qwen / DeepSeek / OpenAI / Anthropic）生成 **论文解读** 与 **公式逐步推导**；
3. 一键 **导出 Markdown**（含 `$$...$$` 公式与 YAML front-matter）。

关键设计原则：**抽取来源对下游透明**——所有 extractor 归一到 `PaperContent`，Summary / Derivation / Export 三条链路不关心数据来自 DOM 还是 PDF。

**PDF 路径要点**：不读 Chrome 内置阅读器沙箱；SidePanel 按 `tab.url` 自己 `fetch` 字节，用 pdf.js 解析——原文留在标签页，侧边栏出结果，天然并排。详见 `docs/plan-pdf-extraction.md`。

---

## 2. 运行时组件拓扑（MV3）

```
┌────────────────────────────────────────────────────────────────┐
│ Chrome                                                          │
│                                                                │
│  ┌───────────────┐   PAGE_READY / EXTRACT_PAPER   ┌──────────┐ │
│  │ Content Script │◀──────────────────────────────▶│ SidePanel│ │
│  │ (arxiv 页注入) │   SCROLL_TO_FORMULA            │  (React) │ │
│  └───────────────┘                                 └────┬─────┘ │
│         抽取 DOM→PaperContent                            │ Port  │
│                                                         │ (LLM) │
│                                              ┌──────────▼──────┐ │
│                                              │ Service Worker  │ │
│                                              │ (background.ts) │ │
│                                              │  LLM Port 路由   │ │
│                                              └──────────┬──────┘ │
│                                                         │ fetch  │
└─────────────────────────────────────────────────────────┼──────┘
                                                          ▼
                                          LLM Provider APIs (SSE)
```

- **Content Script**（`entrypoints/content.ts`）：仅注入到 arXiv 域名。负责发 `PAGE_READY`、响应 `EXTRACT_PAPER`（在页面上下文里跑 extractor）和 `SCROLL_TO_FORMULA`（回跳高亮）。
- **SidePanel**（`entrypoints/sidepanel/`）：主 UI。三个 Tab：论文解读 / 公式推导 / 导出。它是所有用户交互与状态的中心。
- **Service Worker**（`entrypoints/background.ts` + `src/llm/bgHandler.ts`）：只做两件事——(1) 点击图标打开 SidePanel；(2) 承载 LLM 流式 Port，把 SidePanel 的对话请求转成对各 Provider 的 `fetch` + SSE，再流回。**API Key 只在这里读取和使用，绝不注入页面。**
- **Options 页**（`entrypoints/options/`）：BYOK 配置（各 Provider 的 Key、模型、为解读/推导分别绑定模型、测试连接）。

### 为什么 LLM 走 Service Worker 而不是 SidePanel 直接 fetch？

- CORS / `host_permissions`：Provider 域名在 `wxt.config.ts` 的 `host_permissions` 白名单里，Service Worker 发请求不受页面 CORS 限制。
- 隔离密钥：Key 不进入任何页面上下文。
- 统一重试与取消：`src/llm/retry.ts` + Port 协议里的 abort。

---

## 3. 目录与模块职责（现状）

```
entrypoints/
  background.ts            Service Worker：openPanelOnActionClick + installLlmPortHandler
  content.ts               Content Script：PAGE_READY / EXTRACT_PAPER / SCROLL_TO_FORMULA
  sidepanel/
    App.tsx                主壳：tab 同步、会话缓存 hydrate、API Key 引导条、抽取触发
    tabs/SummaryTab.tsx    论文解读（流式）
    tabs/DerivationTab.tsx 公式推导（按章节分组的列表 + 详情视图）
    tabs/ExportTab.tsx     导出预览 + 下载
  options/Options.tsx      BYOK 设置页

src/
  extractors/              页面 → PaperContent（来源归一层）
    types.ts               PaperContent / Section / Formula / Reference 定义 + parseArxivId
                           （含 source/formulaSupport/pageCount 等可选字段，兼容 PDF 来源）
    arxiv.ts               detectKind(url) + extractPaper(doc,url) 分发入口
    abs.ts                 /abs 摘要页抽取
    latexml.ts             /html + ar5iv（LaTeXML 生成的 HTML）抽取
  pdf/                      PDF 来源（arXiv /pdf/，字节 → PaperContent）
    loadPdfjs.ts           pdf.js 懒加载 + Worker 配置（?url 导入）
    extractPdf.ts          PDF 文档编排、逐页进度、结构失败降级
    textLayout.ts          混合单双栏读序、聚行、页眉页脚与分段
    structure.ts           标题/作者/章节/参考文献启发式
    sourceUrl.ts           PDF URL、签名、下载与上传缓存键
    sourceAccess.ts        在线 origin / file:// 最小权限流程
    progress.ts            分页进度与主线程让出
  formula/
    extract.ts             从 <math> DOM 节点提取 LaTeX（含 display 推断）
    mathMarkdown.ts        Markdown 里 $...$ / $$...$$ ↔ KaTeX 渲染占位
  llm/
    types.ts               ChatMessage / Provider 接口
    providers/             qwen / deepseek / openai / anthropic / openaiCompatible / index
    protocol.ts            SidePanel↔Background Port 消息协议
    bgHandler.ts           Service Worker 侧：接 Port、调 Provider、流回、可取消
    retry.ts               fetchWithRetry：429/5xx + 网络错误指数退避（仅首字节前）
    sse.ts                 SSE 行迭代器
  bridge/
    extractBridge.ts       SidePanel→Content：requestExtractFromActiveTab / requestScrollToFormula
    pdfSource.ts           SidePanel：识别来源、申请最小权限、fetch PDF 字节并解析
    llmBridge.ts           SidePanel→Background：chatStream / chatOnce（含 abort 透传）
  pipelines/
    summarize.ts           解读流水线（长文 Map-Reduce、token 预算控制）
    derive.ts              单公式推导流水线
  prompts/
    summary.ts / derivation.ts   Prompt 模板
  storage/
    settings.ts            chrome.storage.local：Provider Key/模型、任务绑定；onSettingsChanged
    cache.ts               chrome.storage.session：按 URL 缓存 paper/summary/derivations
  export/
    markdown.ts            PaperContent + 结果 → Markdown 文本
    download.ts            chrome.downloads 封装
  components/MarkdownView.tsx  marked + DOMPurify + KaTeX 渲染
  util/tokenEstimate.ts    轻量 token 估算 + 截断
```

---

## 4. 核心数据模型：`PaperContent`

定义见 `src/extractors/types.ts`。这是整个项目的「契约」——**新增 PDF 来源时要么复用它，要么最小化扩展它**。

```ts
interface PaperContent {
  arxivId: string;        // arXiv id；无法识别时为空
  url: string;            // 当前页 URL（arXiv /pdf/ 用真实 URL；上传兜底才用合成 key）
  kind: 'abs' | 'html' | 'ar5iv';   // PaperContent.kind 仍用 arXiv 联合类型；PDF 用 source='pdf' 区分（kind 占位 'html'）
  title: string;
  authors: string[];
  categories: string[];
  abstract: string;
  sections: Section[];    // 章节树（含 paragraphs 与 formulaIds）
  formulas: Formula[];    // 扁平公式列表，id 从 1 起
  references: Reference[];
  extractedAt: number;
  warnings: string[];     // 抽取告警，UI 会展示给用户
}

interface Section {
  level: number;          // 1=一级标题, 2=二级…
  heading: string;
  paragraphs: string[];   // 段落文本（公式已用 $...$ 占位）
  formulaIds: number[];   // 本节直接包含的公式 id（不含子节点）
  anchor?: string;
  children: Section[];
}

interface Formula {
  id: number;             // 扁平索引，1 起
  latex: string;
  display: boolean;       // true=块级 $$，false=行内 $
  sectionPath?: string;   // "A > B"，给 LLM 语境
  context?: string;       // 公式上文若干字
  anchor?: string;        // data-pl-fid，用于回跳
}
```

### 下游对该模型的依赖（改模型前必读）

- **DerivationTab**：用 `sections[].formulaIds` 做「按章节分组」；用 `formula.display` + `latex.length<=2` 判定「符号 chip」；用 `formula.anchor` 做回跳（`SCROLL_TO_FORMULA`）。
- **summarize.ts**：吃 `title/abstract/sections/paragraphs`，长文按 section 切分做 Map-Reduce。
- **export/markdown.ts**：吃全部字段生成 `.md`。
- **cache.ts**：按 `url` 键缓存整个 paper + 结果。

---

## 5. 关键数据流

### 5.1 抽取（arXiv）

1. 用户在 arXiv 页打开 SidePanel。`App.tsx` 通过 `chrome.tabs.query` 拿到活动 tab，`classify(url)`（复用 `detectKind`）判断是否受支持。
2. 用户点「抽取本页」→ `handleExtract()` → `requestExtractFromActiveTab()`（extractBridge）→ 给 content script 发 `EXTRACT_PAPER`。
3. content script 在**页面上下文**里跑 `extractPaper(document, url)` → 返回 `PaperContent`。
4. SidePanel setState，并由 `useEffect` 写入 `chrome.storage.session`（按 URL）。

### 5.2 生成解读 / 推导（LLM）

1. Tab 组件调用 `pipelines/summarize.ts` 或 `derive.ts`。
2. 流水线用 `llmBridge.chatStream/chatOnce` 打开一条到 Service Worker 的 Port。
3. `bgHandler.ts` 按 `settings` 选定 Provider + 模型，调 `providers/*` → `fetchWithRetry` → SSE 逐块流回。
4. Tab 边收边渲染（`MarkdownView` + KaTeX）。用户可中途取消（abort 透传到 fetch）。

### 5.3 tab 同步与缓存 hydrate（易踩坑点）

`App.tsx` 监听 `chrome.tabs.onActivated / onUpdated` 和 content 的 `PAGE_READY`，切页时按 URL 从 `chrome.storage.session` 恢复已生成内容。用 `hydratedUrl` 门控，避免「恢复完成前把空状态写回缓存」的竞态。**arXiv `/pdf/` 直接用真实 URL 作缓存 key；仅上传兜底路径才需要合成 key（Phase B）。**

---

## 6. 扩展点（接新来源时会碰到的地方）

| 若要新增一种论文来源，需要改/新增 | 位置 |
|---|---|
| 归一到统一结构 | 新增 `src/extractors/<source>.ts`，输出 `PaperContent` |
| 来源类型标识 | `types.ts` 的 `kind` / 新增 `source` 字段 |
| 触发抽取 | `App.tsx` 的 `handleExtract` 需按来源分支；非 tab 来源不走 `extractBridge` |
| 页面受支持判定 | `App.tsx` 的 `classify` / `supported` |
| 回跳能力 | `SCROLL_TO_FORMULA` 依赖页面 DOM，非 DOM 来源需降级（如显示页码） |
| 缓存 key | `cache.ts` 按 `url`，非 tab 来源需合成稳定 key |

> 这张表就是 `docs/plan-pdf-extraction.md` 的行动纲要来源。

---

## 7. 构建 / 校验 / 提交

- `pnpm compile`：仅 tsc 类型检查（**每次改动后必跑**）。
- `pnpm build`：产物到 `.output/chrome-mv3/`。
- `pnpm test:pdf`：PDF 权限、来源、版面、结构和进度的 Node 单元/功能回归。
- `pnpm test:phase-b:browser`：临时加载构建产物，用真实 PDF 回归 arXiv、上传、`file://` 和导出；`test:phase-b:permissions` 额外验证当前 origin 权限弹窗。
- `pnpm dev`：HMR 开发。
- 提交：Windows 下用 Git Bash（`D:\tools\Git\bin\bash.exe -lc '...'`），避免 PowerShell 对 `<>`/`&&`/heredoc 的解析问题；复杂 commit message 走临时文件 + `git commit -F`（见 `git-push-flow` skill 与 dev-notes）。
- 远端：`github.com/SWUSTcyt/paperlens`，主分支 `main`。

---

## 8. 已知约束与注意事项

- **ar5iv 的 `<math>` 会把块级公式也标成 `display="inline"`**：`formula/extract.ts` 已改为从祖先容器（`.ltx_equation` 等）推断 display，勿回退。
- **KaTeX** 使用 `throwOnError: true`，渲染失败回退 `<code>`，避免坏公式污染整页。
- **权限最小化**：arXiv 与 Provider 使用固定 host permission；任意在线 PDF 通过 `optional_host_permissions` 只申请当前 origin；`file:///*` 仍需用户在扩展详情手动开启。
- **chrome.storage.session** 有容量上限（约 10MB/键空间量级），缓存整篇 paper 可以，勿缓存原始二进制。
