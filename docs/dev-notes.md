# PaperLens 开发笔记

记录开发过程中的踩坑与关键决策，M7 时会沉淀为 `browser-extension-dev` Skill。

> 相关文档：
> - `docs/architecture.md` — 项目当前架构与交接参考（onboarding 必读）
> - `docs/plan-pdf-extraction.md` — 下一个大功能「本地 PDF 文本解析」的完整方案

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
