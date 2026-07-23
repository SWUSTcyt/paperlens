# PaperLens

一款面向论文精读的 Chrome 扩展：支持 arXiv 页面、在线/本地 PDF 与文件上传，一键生成**论文解读**、**公式逐步推导**，并**导出为 Markdown** 文件。

## 特性

- **多来源抽取**：支持 arXiv 摘要页（`/abs`）、HTML 全文（`/html`）、ar5iv 镜像，以及 arXiv、任意在线和本地 `file://` PDF；也可直接选择或拖入 PDF 文件。PDF 场景下原文仍显示在标签页、解析结果在侧边栏，**边看边读**。
- **PDF 本地解析**：pdf.js Worker 在扩展内解析文本层，支持单双栏阅读顺序、页眉页脚清理、断词/段落重建、标题/作者/参考文献识别和逐页进度；原始 PDF 二进制不写入浏览器缓存。
- **论文解读**：结构化总结研究问题 / 方法 / 主要贡献 / 实验与结果 / 结论；长论文自动 Map-Reduce 压缩，支持简洁 / 详细两档粒度。
- **公式逐步推导**：网页真 LaTeX 支持回跳原文；PDF 默认以 Phase C 实验性候选回退，也可启用只连接 `127.0.0.1` 的 MinerU 3.4.4 本地服务，获得展示公式、page+bbox 与按需裁剪图。OCR LaTeX 不冒充作者源码，推导前会提示核对。
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
- PDF 解析：`pdfjs-dist`（在 SidePanel 内本地解析，Worker 独立懒加载）
- 可选本地 OCR：Python 3.12 + MinerU 3.4.4 pipeline（独立 localhost 薄服务）
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
pnpm test:pdf         # PDF 单元/功能回归
pnpm test:phase-c:browser # 真实 PDF + 扩展 UI 冒烟（需本机 Chrome/Edge）
pnpm test:mineru:client   # MinerU client/provider 契约与回退
pnpm test:mineru:browser  # 真实本地 MinerU 浏览器闭环（需先启动服务）
pnpm zip              # 打 zip 包以上架 Chrome Web Store
```

### 可选：启用本地 MinerU 公式识别

本功能默认关闭，不影响现有 PDF 解析与 Phase C 回退。Windows 源码安装命令、配置位置和安全边界见 [`services/mineru/README.md`](./services/mineru/README.md)。启动 `paperlens-mineru serve` 后，在扩展设置页填写首次生成的 token，点“测试连接”，成功后勾选“对 PDF 启用本地 MinerU”。

Windows 本地服务可通过 GitHub Releases 稳定通道自动或手动检查更新，操作说明见 [`services/mineru/README.md`](./services/mineru/README.md)；该通道不更新 Chrome 扩展本体。

启用后，PDF 正文/章节仍由 pdf.js 先完成并立即可用于解读；MinerU 作为独立增强任务运行。失败、取消、超时或结果校验失败都保留 Phase C 基线，不会清空论文内容。

### 手动加载扩展

1. 执行 `pnpm build`
2. 打开 Chrome → `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3/` 目录
5. 打开任一论文来源，例如：
   - 摘要页：<https://arxiv.org/abs/2310.06825>
   - HTML 全文：<https://arxiv.org/html/2310.06825>
   - ar5iv：<https://ar5iv.labs.arxiv.org/html/2310.06825>
   - PDF：<https://arxiv.org/pdf/2310.06825>（在 PDF 标签页点「解析本页 PDF」，可边看 PDF 边读解读）
   - 其他在线 PDF：首次解析时仅申请当前站点权限
   - 本地 `file://` PDF：需在扩展详情开启「允许访问文件网址」
6. 点击工具栏的 PaperLens 图标 → SidePanel 打开
7. 首次使用请先点底部「设置 / 配置 API Key」，填入至少一家 LLM 的 Key 并「测试连接」

也可以在 SidePanel 中选择或拖入 PDF 文件，无需先在标签页打开。

### 典型使用流

1. 在 arXiv 论文页打开 PaperLens SidePanel
2. 点顶部「抽取本页」—— 几秒内完成 DOM → `PaperContent` 抽取（标题、作者、章节、公式、参考文献）
3. 「论文解读」Tab → 选择粒度 → 点「生成解读」
4. 「公式推导」Tab → 从列表中选中任意公式 → 点「生成推导」；网页公式可回跳原文，PDF 候选按“第 N 页”定位
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
│   ├── pdf/                         # PDF 解析（pdf.js 懒加载 + 版面重建 → PaperContent）
│   ├── mineru/                      # localhost client、schema 校验与设置契约
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
├── services/mineru/                 # Python 3.12 + MinerU 3.4.4 本地薄服务
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
- [x] M7 沉淀 Cursor Skill：`browser-extension-dev`（已随仓库分享，见 [`.cursor/skills/`](./.cursor/skills/)）+ `git-push-flow`（个人全局，未入库）
- [x] M8 arXiv PDF 解析（甜点场景）：在 `/pdf/` 页 fetch 字节 + pdf.js 本地解析 → 论文解读 / 导出打通（详见 [`docs/plan-pdf-extraction.md`](./docs/plan-pdf-extraction.md)）
- [x] M9 PDF Phase B：任意在线/本地/上传摄入，单双栏版面与结构增强，逐页进度及浏览器关键路径验收
- [x] M10 PDF Phase C：疑似公式候选、AI 先还原再推导、实验性标识与页码定位
- [x] M11 MinerU 薄集成 Epic A/B：安全本地服务、事务回退、真实进度/取消、展示公式与裁剪核对

### 待办（欢迎 PR）

- **PDF 公式质量调优**：扩充代表论文样本，持续校准候选阈值与不同模型的 LaTeX 还原质量。
- **MinerU Epic C**：完善 Windows 升级/卸载/故障排查与取消、超时、TTL 后裁剪失效的发布级浏览器矩阵。

- **KaTeX 字体瘦身**：默认打包了 Main/AMS/Caligraphic/Fraktur 等全部字形，可按需剔除仅保留 Main+AMS。
- **多论文对比**：目前只解读"当前活动 Tab"，后续可以沉淀历史。

## 隐私

- 所有 LLM API Key 仅存于 `chrome.storage.local`，只在扩展的 Service Worker 中使用，不随任何页面注入。
- 没有任何遥测或云端同步，导出和解读均为本地操作。
- arXiv / ar5iv 使用固定白名单；其他在线 PDF 只在点击解析时申请当前 origin 权限，本地 `file://` 访问由浏览器扩展详情开关控制。
- 上传 PDF 仅在本机内存中解析，缓存只保存结构化结果和内容摘要键，不保存原始二进制。
- 可选 MinerU 只连接 `127.0.0.1`；token 仅存 `chrome.storage.local`。服务端输入 PDF 在任务终态删除，结构化结果/裁剪图默认 24 小时 TTL，模型与本地任务产物不进入 Git。
- 发往 LLM 的是论文的**结构化文本**（不含完整 PDF），且只在你显式点击「生成解读 / 生成推导 / 测试连接」时发送。

## 许可

MIT
