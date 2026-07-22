# PaperLens 开发笔记

记录开发过程中的踩坑与关键决策，M7 时会沉淀为 `browser-extension-dev` Skill。

> 相关文档：
> - `docs/architecture.md` — 项目当前架构与交接参考（onboarding 必读）
> - `docs/plan-pdf-extraction.md` — PDF Phase A–C 的完整方案与验收状态

## 时间线补记（M7 之后）

- **公式列表按章节重组**（`DerivationTab.tsx`）：从扁平列表改为按 `sections[].formulaIds` 分组；同章节内相同 LaTeX 去重并标 `×N`；单变量/极短行内公式排后并弱化为可点击的小 chip（不隐藏，照顾数学基础较弱的用户）。
- **display 识别修复**（`formula/extract.ts`）：ar5iv/LaTeXML 会把块级方程的 `<math>` 也标成 `display="inline"`，改为从祖先容器（`.ltx_equation` 等）推断 display。
- **会话缓存与 tab 同步**（`storage/cache.ts` + `App.tsx`）：按 URL 缓存 paper/summary/derivations，切 tab / 页内跳转时恢复；用 `hydratedUrl` 门控避免竞态。
- **提交环境约定**：Windows 下 git 操作走 Git Bash（PowerShell 对 `<>`/`&&`/heredoc 解析有坑），复杂 commit message 用临时文件 + `git commit -F`。

## M8 arXiv PDF 解析（甜点场景）

- **核心认识**：Chrome 内置 PDF 阅读器是封闭沙箱，content script 抓不到内容；但标签页 `tab.url` 就是 PDF 地址，扩展可**自己 fetch 同一 URL 的字节**用 pdf.js 独立解析——绕开沙箱，且原文继续显示在标签页，解析结果在侧边栏，天然并排。
- **甜点场景**：arXiv `/pdf/` 链接。`host_permissions` 已含 `*://*.arxiv.org/*`，fetch 无需新权限，是投入最小、收益最大的切入点。
- **pdf.js（pdfjs-dist 6.1.200）集成**：
  - Worker 用 Vite 的 `?url` 导入：`import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` → 设 `GlobalWorkerOptions.workerSrc`。构建后 worker 输出为扩展内 `assets/pdf.worker.min-*.mjs`（同源，无需 `web_accessible_resources`）。
  - 主库用动态 `import('pdfjs-dist')` 懒加载，构建后是独立 chunk（`chunks/pdf-*.js` ~425kB），不拖累 SidePanel 首屏。
  - `tsc` 识别 `?url`：在 `src/globals.d.ts` 加 `declare module '*?url'`。
- **版面重建**（`src/pdf/extractPdf.ts`）：分栏（中缝双峰判据）→ 按 y 聚行、按 x 拼接 → 去页眉页脚（跨页重复短文本 + 纯页码）→ 去连字符/分段 → 标题（首页最大字号簇）/摘要（Abstract 定位）/章节（编号或大字号）/参考文献（[n]、n. 切分）。任何步骤失败降级为整篇纯文本，保证解读可用。
- **数据模型**：`types.ts` 只加**可选**字段（`source`/`formulaSupport`/`pageCount` + `Formula.page`/`confidence`），arXiv 路径零回归。
- **MVP 边界**：`formulaSupport='none'`，公式列表为空；公式识别（PDF 内无 LaTeX，需启发式 + AI 还原）留待 Phase C。

## M9 PDF Phase B

- **按需权限**：在线 PDF 只从点击事件直接请求当前 origin，避免异步查询打断 Chrome 的用户手势；`file:///*` 必须声明 host match，实际访问仍由扩展详情页开关控制。
- **上传隐私**：缓存键使用文件名、大小与 SHA-256 摘要；`ArrayBuffer` 只进入 pdf.js，不写入 `chrome.storage.session`。
- **版面拆分**：纯算法移到 `textLayout.ts` / `structure.ts`，用合成坐标覆盖通栏标题 + 双栏正文、边缘重复文本、跨栏断段、多类标题和参考文献。
- **大文件体验**：每页完成后报告进度并 `setTimeout(0)` 让出渲染；loading task 在 `finally` 中销毁。
- **真实样本回归**：Attention PDF 首页把 8 位作者和 Unicode 脚注符号排在同一文本行；作者解析需按 `¹²³⁴⁵⁶⁷⁸⁹∗*†‡` 拆分，不能只按逗号或换行判断。该缺陷先由浏览器冒烟发现，再补 Node 回归测试。
- **验收**：17 项 Node 测试覆盖权限/下载正常与异常路径及版面结构；Edge 冒烟覆盖 arXiv 三类 URL、Attention 双栏、Adam 单栏、上传、`file://`、Markdown 导出，并实际完成任意在线 PDF 当前 origin 权限允许与解析。

## M10 PDF Phase C（实验性公式）

- **候选而非 OCR**：`formulaHeuristic.ts` 只使用文本层信息，综合数学字体占比、Unicode 数学符号、居中短行与行尾公式编号打分；短噪声、页边缘和参考文献区排除。没有达到质量门禁的候选时继续使用 `formulaSupport='none'`。
- **原文契约**：heuristic 模式的 `Formula.latex` 实际保存原始 PDF 文本，同时填 `page/confidence/context/sectionPath`；ID 回填到章节树。UI 与 Markdown 导出不得把它伪装成真实 LaTeX。
- **推导隔离**：`derive.ts` 只在 `formulaSupport='heuristic'` 时选择“先还原 LaTeX，再逐步推导”prompt；网页真 LaTeX 继续原 prompt 和 `SCROLL_TO_FORMULA`。PDF UI 显著提示“AI 识别，实验性”，定位降级为页码。
- **真实样本**：Attention PDF 识别到 3 条高置信候选，均有页码、上下文、章节路径且写入 `formulaIds`；原始文本仍可能缺失字形，必须依赖上下文保守还原。阈值优化属于后续 P2，不以提高召回率为由放宽误报门禁。
- **验收边界**：25 项 Node 测试通过；Edge 冒烟覆盖 PDF 候选/UI/页码、网页真 LaTeX 隔离和浏览器内模拟 LLM Port 的流式 prompt 链。临时 profile 无 API Key，真实 Provider 的还原与教学质量仍需带 Key 人工评估。

## M11 MinerU pipeline 薄集成（Epic A/B）

- **基线先成、增强后到**：pdf.js/Phase C 先产出完整 `PaperContent` 并立即开放解读；MinerU job 独立运行，只有完整 schema 校验通过后才原子替换公式字段。连接、401、版本、队列、任务失败、超时、取消和坏结果均保留原 baseline。
- **安全边界**：扩展只构造 `http://127.0.0.1:<port>`；token 仅存 `chrome.storage.local`，不进入错误、导出或 Git。服务固定 MinerU 3.4.4 pipeline、单并发、200 MiB/500 页、30 分钟任务超时，输入在终态删除，result/crop 默认 24 小时 TTL。
- **UI 与 prompt 隔离**：MinerU 无可靠页级事件时只显示真实阶段与耗时；展示公式携带 page+bbox 和惰性鉴权 crop，行内公式只显示统计。OCR 使用独立 prompt，不得凭经典论文记忆静默补齐，也不得冒充作者 TeX 源码。
- **真实闭环**：Edge 上传 Attention PDF 后完成 5 条展示公式、108 处行内统计、全部章节关联与鉴权 crop；随后 Adam 单栏、`file://` 与 Markdown 导出通过。网页 `/abs`、`/html`、`/pdf`、真 LaTeX 回跳和 Phase C prompt 独立回归通过。
- **浏览器专属坑**：原生 `fetch` 保存为实例字段后若以 `this.fetchImpl(...)` 调用，Chrome/Edge 会因错误接收者在请求前抛 `Illegal invocation`。默认 fetch 必须绑定 `globalThis`，并保留接收者回归测试。
- **验收产物新鲜度**：一次浏览器冒烟曾复制早于源码的 `.output`，表现为 UI 永远等不到 job。浏览器测试命令现已强制先 `pnpm build`；以后不得用旧构建证明当前源码可用。
- **冻结模型优先于测试猜测**：文档级 OCR 来源用 `formulaRecognition.provider`，逐公式来源用 `Formula.recognitionSource`。测试曾错误要求未冻结的 `PaperContent.recognitionSource`，被 TypeScript 拦下后按 Spec 修正，未扩张模型。

## M12 MinerU Windows 交付（Epic C1）

- **运行时不可搬迁**：Windows venv 的入口记录解释器绝对路径，不能先在 staging 构建再整体改名。安装器改为在最终 `versions/generation_*` 路径构建，候选通过 `init/check-config/doctor` 后只原子切换 `current.txt`；失败删除候选并保留旧 generation。
- **目录所有权**：运行时根必须有 `.paperlens-mineru-runtime` marker；无 marker 的现存目录一律拒绝覆盖。配置与任务数据禁止放进可替换运行时目录。
- **可分享诊断**：`doctor` 只输出稳定错误码、版本、端口和字节统计，不输出 token、配置/缓存绝对路径或底层异常；首次 token 仍只在 `init` 创建配置时显示一次。
- **Windows 进程边界**：PowerShell 5.1 脚本必须用 UTF-8 BOM，并统一控制台/Python UTF-8。IDE 可能同时注入 `Path/PATH`，调用 `Start-Process` 前要在子进程内定点重建 `PATH`。内部变量不得占用受保护的 `PAPERLENS_MINERU_*` 配置前缀。
- **真实验收**：全新隔离运行时首次安装 51.7 秒、约 2.27 GB；同路径重装保持配置/token，health 与扩展 client 成功，结束后 17860 端口无监听。

## M0 环境搭建

### 关键选型

| 项 | 选择 | 理由 |
|---|---|---|
| 扩展框架 | WXT 0.20 | 现代 Manifest V3 支持、多 entrypoint、HMR、自动 manifest 生成 |
| UI 框架 | React 19 | 配 `@wxt-dev/module-react` 自动接入 |
| 样式 | Tailwind CSS v3.4 | v4 生态未完全稳定，v3 在 Chrome 扩展场景踩坑最少 |
| 包管理器 | pnpm 10 | 节省磁盘、装包快 |
| 类型检查 | TypeScript 6 | 最新稳定版 |

### 踩坑记录

1. **pnpm 的 build scripts 默认被忽略**
   - 现象：安装依赖时警告 `Ignored build scripts: esbuild@..., spawn-sync@...`
   - 原因：pnpm 10 出于安全考虑默认不运行依赖的 install 脚本
   - 解法：在 `package.json` 中加入
     ```json
     "pnpm": { "onlyBuiltDependencies": ["esbuild"] }
     ```

2. **`default_locale` 触发 Chrome 加载报错**
   - 现象：manifest 里写 `default_locale: 'zh_CN'`，但没建 `_locales/zh_CN/messages.json`
   - 解法：要么去掉 `default_locale`，要么补齐 `_locales` 文件。一期暂时去掉。

3. **SidePanel "点击图标打开"**
   - 现象：Manifest V3 的 SidePanel 默认不会在点击工具栏图标时弹出
   - 解法：在 `background.ts` 调用
     ```ts
     chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
     ```
     并确保 manifest 含 `action` 字段

### 关键命令速查

- `pnpm wxt prepare` — 生成 `.wxt/` 目录下的类型与辅助文件（tsconfig 通过 extends 这里引入）
- `pnpm dev` — 自动打开 Chrome 并加载未打包扩展（开发用）
- `pnpm build` — 输出到 `.output/chrome-mv3/`（手动加载到 Chrome 用）

### 验证 M0 通过的标准

1. `pnpm build` 成功无报错
2. `.output/chrome-mv3/manifest.json` 包含 `side_panel.default_path` 与 `content_scripts` 条目
3. 在 Chrome 的 `chrome://extensions` 以「加载已解压的扩展」方式载入 `.output/chrome-mv3/`
4. 访问任意 arXiv URL（如 `https://arxiv.org/abs/2310.06825`），点击工具栏的 PaperLens 图标 → 侧边栏弹出，标题栏显示论文标题，三个 Tab 可切换（内容为占位）
