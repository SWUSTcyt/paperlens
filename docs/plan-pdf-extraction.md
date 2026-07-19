# 方案：本地 PDF 文本读取与解析

> 状态：**Phase A、Phase B 已完成；Phase C 待续。**
> 前置阅读：`docs/architecture.md`（尤其第 4 节数据模型、第 6 节扩展点）。
> 目标读者：接手实现者（含未来的自己）。本文件力求「照着做即可落地」。

---

## 0. 关键设计修正（务必先读）

最初设想是「用户上传/拖入 PDF 文件」，但这样**原文不在浏览器里显示，丢失了"边看边解析"的体验**。修正后的核心认识：

- Chrome 里打开 PDF 时，标签页的 `tab.url` **就是 PDF 本身的地址**（`https://...pdf` 或 `file://...pdf`）。
- 内置 PDF 阅读器（PDFium）是封闭沙箱，content script **进不去**、抓不到其内容。
- 但扩展可以**照着这个地址自己再 fetch 一份 PDF 字节**，用 pdf.js 独立解析——**这不是攻破沙箱，而是绕开它**（相当于"自己去书架拿一本一样的书"，而不是读别人手上那本）。
- 结果：**PDF 继续显示在标签页，解析结果在侧边栏 → 天然并排**。这才是主路径；文件上传降为兜底。

### 摄入优先级（修正后）

1. **Path 1（主）**：当前标签是在线 PDF（https）→ 侧边栏 fetch 同一 URL → 解析。
2. **Path 2**：当前标签是本地 `file://` PDF → 同样 fetch 解析，但需用户开启扩展的「允许访问文件网址」开关。
3. **Path 3（兜底）**：文件选择 / 拖拽 → 内存解析（原文不显示，无并排）。

### 甜点场景（Phase A 已落地）

**arXiv `/pdf/` 链接**（如 `arxiv.org/pdf/2310.06825`）是 Path 1 的最佳切入点：

- `host_permissions` 里**已有** `*://*.arxiv.org/*`，fetch 无需任何新权限、无过审顾虑。
- 用户群与 PaperLens 高度重合，很多人正是直接开 `/pdf/` 看论文。
- 文件小、并排体验直接成立。

---

## 1. 背景与目标

当前 PaperLens 只支持 arXiv 三种网页来源。用户希望**能对 PDF 论文**同样使用「论文解读 / 公式推导 / 导出 Markdown」。

### 目标（本功能范围）

1. 用户在 SidePanel 里对**当前标签页打开的 PDF**一键解析（主路径），扩展本地解析出文本与结构，归一为 `PaperContent`，复用现有三条链路。
2. **论文解读**对 PDF 完整可用（这是最现实、最高价值的部分）。
3. **公式推导**在 PDF 下以「实验性」形态提供：抽取疑似公式区域的原始文本，交由 LLM 还原为 LaTeX 再推导，并明确标注可能不准（Phase C）。
4. **导出 Markdown**对 PDF 来源可用。

### 非目标（本次不做）

- 不去读 Chrome 内置 PDF 阅读器沙箱里的内容（做不到）；而是 fetch 其 URL 独立解析。
- 不接入外部数学 OCR / 云服务（成本与隐私考虑；符合用户此前「暂不引入外部端点」的约束）。
- 不做扫描版/图片型 PDF 的 OCR（无文本层的 PDF 直接提示不支持）。
- 不做 PDF 内的公式「回跳高亮」（无页面 DOM），用「页码」代替定位。

### 已实现（Phase A，本次）

- `src/pdf/loadPdfjs.ts`：pdf.js 懒加载 + Worker 配置（`?url` 导入，构建后独立 chunk，不拖累首屏）。
- `src/pdf/extractPdf.ts`：字节 → `PaperContent`（分栏 → 聚行 → 去页眉页脚 → 去连字符/分段 → 标题/摘要/章节/参考文献识别；失败降级整篇纯文本）。
- `src/bridge/pdfSource.ts`：`detectPdfUrl`（放行 arXiv /pdf/）+ `extractPdfFromActiveTab`（fetch 字节并解析）。
- `types.ts`：新增可选字段 `source/formulaSupport/pageCount` 与 `Formula.page/confidence`（arXiv 路径零回归）。
- `App.tsx`：`classify` 识别 pdf、`handleExtract` 分支、`ExtractBar` 文案（"解析本页 PDF"、"N 页 · M 章节"）、`UnsupportedHint` 增加 arXiv PDF 提示。
- `DerivationTab`：PDF 来源（`formulaSupport==='none'`）显示专门的空态提示，引导去 HTML/ar5iv 版看公式。
- MVP 阶段 `formulaSupport='none'`，公式列表为空（公式识别留待 Phase C）。

---

## 2. 核心技术难点与结论

| 难点 | 结论 / 策略 |
|---|---|
| PDF 无 DOM、无法用 content script 抓取 | **不读阅读器沙箱**；SidePanel 按 `tab.url` 自己 `fetch` 字节，再用 `pdfjs-dist` 解析（绕开 PDFium）。 |
| pdf.js 的 worker 在 MV3 下的加载 | 用 Vite/WXT 的 `?url` 导入 worker 并设 `GlobalWorkerOptions.workerSrc`；构建后为同源 `assets/pdf.worker.min-*.mjs`，无需 `web_accessible_resources`。 |
| PDF 只有带坐标的文本片段，无语义结构 | 自研**版面重建**：按 y 聚行、x 分栏、去页眉页脚、去连字符、合并段落、基于字号/编号识别标题。 |
| PDF 里没有 LaTeX（数学是字形） | **不追求完美**。Phase A MVP 直接 `formulaSupport='none'`；Phase C 再做启发式识别 + LLM 还原，UI 标注「AI 识别，实验性」。 |
| 抽取质量天然弱于 arXiv HTML | PDF 是补充通道（尤其 `/pdf/` 直开用户）；HTML/ar5iv 仍是公式首选；`warnings` 如实告知局限。 |

---

## 3. 依赖

- 新增 `pdfjs-dist`（用 `pnpm add pdfjs-dist`，取最新稳定版；实现时确认版本并记录到 dev-notes）。
- 不引入其他重依赖。KaTeX / marked / DOMPurify 已在。

---

## 4. 数据模型改动（最小化）

在 `src/extractors/types.ts`：

1. 扩展来源标识。**不要**直接把 `'pdf'` 塞进 `ArxivPageKind`（那是 arXiv 语义）。改为新增独立字段：

```ts
/** 论文来源大类 */
export type PaperSource = 'arxiv' | 'pdf';

/** 公式支持程度：latex=有真源码(arXiv)，heuristic=AI识别(PDF)，none=无 */
export type FormulaSupport = 'latex' | 'heuristic' | 'none';
```

2. `PaperContent` 增加两个可选字段（保持向后兼容，arXiv 路径不受影响）：

```ts
interface PaperContent {
  // …现有字段不动…
  source?: PaperSource;          // 缺省视为 'arxiv'
  formulaSupport?: FormulaSupport; // 缺省视为 'latex'
  pageCount?: number;            // PDF 页数（arXiv 为空）
}
```

3. `Formula` 增加可选定位字段（PDF 用页码代替 anchor 回跳）：

```ts
interface Formula {
  // …现有字段不动…
  page?: number;      // 该公式所在 PDF 页（1 起）；arXiv 为空
  confidence?: number; // PDF 启发式识别置信度 0–1；arXiv 为空
}
```

> 原则：**只加可选字段**，让所有现有 arXiv 代码零改动继续工作。

---

## 5. 目录与新增文件

### Phase A 已落地

```
src/pdf/
  loadPdfjs.ts        懒加载 pdfjs-dist + Worker（?url）
  extractPdf.ts       主入口：ArrayBuffer → PaperContent（版面重建 + 结构识别合在此文件）

src/bridge/
  pdfSource.ts        detectPdfUrl + extractPdfFromActiveTab（fetch 当前 tab 的 PDF URL）
```

### Phase B/C 规划新增

```
src/pdf/
  formulaHeuristic.ts     疑似公式区域识别（Phase C）
  （可选拆分 textLayout.ts / structure.ts，若 extractPdf.ts 继续膨胀）

entrypoints/sidepanel/
  PdfPicker.tsx（或并入 App）  Path 3：文件选择 / 拖拽兜底（Phase B）
```

现有 `src/extractors/arxiv.ts` 保持不变；PDF 走独立入口，最终都产出 `PaperContent`。

---

## 6. 版面重建算法（textLayout.ts）—— 实现要点

对每一页 `page.getTextContent()` 得到 items（含 `str`、`transform`[a,b,c,d,e,f]、`width`、`height`、`fontName`）：

1. **坐标归一**：x = transform[4]，y = transform[5]，字号≈|transform[3]|。注意 PDF 坐标原点在左下，y 越大越靠上。
2. **聚行（line grouping）**：按 y 用容差（≈ 0.5×字号）聚类为「行」，行内按 x 升序拼接，item 间按间距决定是否插空格。
3. **分栏（column detection）**：统计行内 item 的 x 分布；若存在明显的中缝空白（双峰），判为双栏，读序为「左栏整列 → 右栏整列」。单栏则按 y 从上到下。
4. **去页眉页脚**：收集每页顶部/底部固定 y 带内、且在多页重复出现的短文本（含纯数字页码、arXiv 水印、会议名）→ 丢弃。
5. **去连字符（de-hyphenation）**：行尾以 `-` 结束且下一行以小写字母开头 → 合并且去掉连字符。
6. **段落合并**：连续行合并为段落，遇到「较大纵向间距 / 明显缩进 / 上一行以句末标点结束且下一行首字母大写并短」等视为段落边界。
7. 输出：有序的 `Block[]`（每个 block 带文本、起止页、平均字号、主字体、是否居中）。

> 健壮性优先：任何一步失败都要降级为「整页纯文本拼接」，并在 `warnings` 里说明「版面重建部分失败，结构可能不准」。

---

## 7. 结构识别（structure.ts）

- **标题/作者**：第 1 页字号最大的 block 作标题；其下若干行作者（启发式：包含逗号/上标数字/机构关键词）。失败则留空并告警。
- **摘要**：匹配 `Abstract` 起，到 `Introduction` 或第一个编号标题止。
- **章节标题**：满足以下之一判为标题，`level` 由编号深度决定：
  - 匹配 `^\d+(\.\d+)*\s+\S`（如 `2`, `2.1`, `3.2.1`）；
  - 字号显著大于正文且较短、独占一行、可能加粗（`fontName` 含 `Bold`）。
- **参考文献**：`References`/`Bibliography` 标题之后，按 `[n]` 或 `n.` 或作者-年份模式切条目。
- 组装成 `Section[]` 树 + `paragraphs`，与 arXiv 输出结构一致。

---

## 8. 公式启发式（formulaHeuristic.ts，Phase C）

> Phase A 已落地降级开关：`formulaSupport='none'`，`DerivationTab` 对 PDF 显示空态并引导去 HTML/ar5iv。以下为 Phase C 方案。

1. **候选识别**：
   - block/行中数学字体占比高（`fontName` 含 `CMMI`/`CMSY`/`CMEX`/`MSAM`/`MSBM`/`STIX`/`Math`/`Symbol`）；
   - 或特殊 Unicode 数学符号密度高（∑∫∏√≤≥≈∞αβγ…下标上标）；
   - 或「居中短行 + 行尾带 `(n)` 编号」→ 判为 display 候选。
2. **产出**：每个候选生成一个 `Formula`：
   - `latex`：**放原始抽取文本**（可能乱码），并置 `confidence`；
   - `display`：由是否独立成行/带编号推断；
   - `page`：所在页；`context`：邻近正文；`sectionPath`：归属章节。
   - `formulaSupport = 'heuristic'`。
3. **推导时**：`pipelines/derive.ts` 感知 `formulaSupport==='heuristic'`，改用「先还原 LaTeX 再推导」的 prompt 变体；UI 显著标注「AI 识别，可能不准」。

---

## 9. SidePanel 接入（App.tsx 等）

### Phase A 已落地（Path 1 甜点：arXiv /pdf/）

1. `PageState.kind` 扩为含 `'pdf'`；`classify(url)` 优先 `detectPdfUrl`，再 `detectKind`。
2. `handleExtract`：`kind==='pdf'` → `extractPdfFromActiveTab()`（SidePanel 内 fetch + `extractPdf`）；否则走现有 content script。
3. `ExtractBar`：PDF 文案为「解析本页 PDF / 重新解析」，统计显示「N 页 · M 章节」。
4. `UnsupportedHint`：增加 arXiv PDF 入口说明。
5. 缓存：直接用真实 `tab.url`（`arxiv.org/pdf/...`）作为 key，复用 `cache.ts`。
6. `DerivationTab`：`formulaSupport==='none'` 时显示 PDF 专用空态（引导 HTML/ar5iv）。

### Phase B 再补的摄入路径

1. **任意在线 PDF**：`optional_host_permissions` + 运行时 `chrome.permissions.request`，用户点「解析本页 PDF」时再申请该域名。
2. **本地 `file://`**：引导开启扩展详情页「允许访问文件网址」；开启后同样 fetch `tab.url`。
3. **上传/拖拽兜底（Path 3）**：`<input type="file">` + 拖拽；合成缓存 key `pdf:<filename>:<size>:<hash>`；原始 `ArrayBuffer` 只留内存，不进 `chrome.storage`。
4. **回跳降级（Phase C）**：有公式时用「第 N 页」代替 `SCROLL_TO_FORMULA`。

---

## 10. 分阶段实施清单（建议提交粒度）

### Phase A — 甜点场景 MVP（arXiv /pdf/ → 解读 + 导出打通）✅ 已完成
- [x] `pnpm add pdfjs-dist`（6.1.200）；`src/pdf/loadPdfjs.ts` 配好 workerSrc（`?url` 导入，构建后独立 chunk）。
- [x] `types.ts` 加 `source/formulaSupport/pageCount` + `Formula.page/confidence`（全可选，arXiv 零回归）。
- [x] 版面重建 + 结构识别合并在 `src/pdf/extractPdf.ts`（聚行/分栏/去页眉页脚/去连字符/分段 + 标题/摘要/章节/参考文献；失败降级整篇纯文本 + `warnings`）。
- [x] `src/bridge/pdfSource.ts`：`detectPdfUrl`（arXiv /pdf/）+ `extractPdfFromActiveTab`（fetch 字节，走现成 host 权限）。
- [x] `App.tsx`：`classify` 识别 pdf、`handleExtract` 分支、`ExtractBar` 文案、`UnsupportedHint` 提示；`DerivationTab` PDF 空态。
- [x] `pnpm compile` + `pnpm build` 通过（pdf 拆为独立懒加载 chunk）。
- [x] 浏览器验证：临时加载 `.output/chrome-mv3/`，真实解析 Attention（双栏）与 Adam（单栏），并验证 Markdown 导出预览。

> 说明：本阶段只放行 **arXiv /pdf/**（Path 1 的甜点子集，权限现成）。任意在线 PDF（`optional_host_permissions` 按需申请）与本地 file:// / 上传兜底放到后续。

### Phase B — 摄入面扩展 + 版面/结构增强 ✅ 已完成
- [x] 摄入面扩展：任意在线 PDF（`optional_host_permissions` + 当前 origin 运行时申请）；本地 `file://`（声明 file host permission，并引导开启“允许访问文件网址”）；文件选择/拖拽兜底（key 为 `pdf:<filename>:<size>:<sha256>`）。
- [x] 双栏检测、页眉页脚去除、连字符与段落合并的鲁棒性提升：通栏块与双栏正文按阅读带排序；页眉页脚按页面边缘与跨页频次清理；跨栏断段。
- [x] 标题/作者/参考文献增强：多行作者与机构过滤；阿拉伯/罗马/附录/粗体标题；编号与作者-年份参考文献。
- [x] 大 PDF 逐页 `await` 让出主线程，并在当前标签/上传两条路径显示页级进度。
- [x] 自动验收：17 项 PDF 单元/功能测试、`pnpm compile`、`pnpm build` 通过。
- [x] 浏览器验收：Edge 临时扩展覆盖 arXiv `/abs`/`/html`/`/pdf`、上传、`file://`、真实单栏/双栏 PDF、Markdown 导出；交互模式实际允许当前 origin 后，任意在线 PDF 解析通过。

浏览器回归命令：`pnpm test:phase-b:browser`；需要复核权限弹窗时运行 `pnpm test:phase-b:permissions` 并在浏览器中选择允许或拒绝。

#### Phase B 使用示例

1. 打开任意 `https://.../paper.pdf`，点击“解析本页 PDF”，仅授权当前站点后边看边解读。
2. 打开 `file://.../paper.pdf`；若提示无权限，进入扩展详情开启“允许访问文件网址”后重试。
3. 在任意页面打开侧栏，把 PDF 拖入上传区；结果以内容摘要键缓存，原始 PDF 字节仅保留在本次解析内存中。

### Phase C — 公式（实验性）
- [ ] `formulaHeuristic.ts` 候选识别；`Formula` 填 `page/confidence/formulaSupport='heuristic'`。
- [ ] `derive.ts` 增加「PDF 公式先还原 LaTeX 再推导」的 prompt 变体（`prompts/derivation.ts`）。
- [ ] `DerivationTab` 对 heuristic 来源加「AI 识别，实验性」标注 + 回跳降级为页码。
- [ ] 提交：`feat(pdf): 实验性公式识别与推导`。

> 每个 Phase 结束都要 `pnpm compile` + `pnpm build` 通过再提交。

---

## 11. 风险与回退

- **worker 加载失败（MV3/CSP）**：优先 `?url` 导入；不行则把 worker 放 `public/` 并加 `web_accessible_resources`；再不行退化为主线程解析（`disableWorker`，慢但可用）。
- **双栏顺序错乱**：先用「行内 x 双峰」判栏；无把握时退单栏（宁可顺序对、丢栏也别交叉错位）。
- **公式质量差**：一键降级 `formulaSupport='none'`，只保解读与导出，不影响主价值。
- **大 PDF 卡顿**：解析在 SidePanel 主线程会阻塞 UI；worker 承担解码，聚合逻辑分页 `await` 让出主线程 + 进度提示。

---

## 12. 测试计划

- 选 3–5 篇代表 PDF：单栏（如某些 preprint）、双栏（NeurIPS/CVPR 双栏）、含大量公式（DDPM/Transformer 的 PDF 版）、含参考文献长列表、一个扫描版（应识别为无文本层并友好提示）。
- 逐 Phase 验证：文本完整性 → 章节/摘要正确性 → 解读质量 → 导出 → 公式（Phase C）。
- 复用离线思路：可写临时 `tsx` 脚本用 Node 侧 `pdfjs-dist` 跑 `extractPdf`，打印章节数/公式候选数做快速回归（参考历史上用 jsdom 测 arXiv 抽取的做法）。

---

## 13. 给实现者的开场提示（Codex 可直接用）

> 参考 `docs/architecture.md` 与本文件。**Phase A（arXiv /pdf/ 甜点场景）已完成**，核心代码在 `src/pdf/`（`loadPdfjs.ts` / `extractPdf.ts`）与 `src/bridge/pdfSource.ts`，接入点在 `entrypoints/sidepanel/App.tsx`。
>
> Phase A、Phase B 已完成。后续若启动 Phase C，应单独拆分公式启发式、derive prompt 变体与 `DerivationTab` 实验性标注，不与本阶段混做。
>
> 全程：数据模型只加可选字段，保证 arXiv 路径零回归；每步 `pnpm compile`/`pnpm build`；遵循仓库规则（中文注释、UTF-8、async/await、完善错误处理，不动无关既有逻辑）。
