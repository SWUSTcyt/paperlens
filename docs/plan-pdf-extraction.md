# 方案：本地 PDF 文本读取与解析

> 状态：**已定方案，待实现**（可在 Codex/其他 IDE 按本文件逐阶段执行）。
> 前置阅读：`docs/architecture.md`（尤其第 4 节数据模型、第 6 节扩展点）。
> 目标读者：接手实现者（含未来的自己）。本文件力求「照着做即可落地」。

---

## 1. 背景与目标

当前 PaperLens 只支持 arXiv 三种网页来源。用户希望**能对本地 PDF 论文**同样使用「论文解读 / 公式推导 / 导出 Markdown」。

### 目标（本功能范围）

1. 用户能在 SidePanel 里**选择/拖入一个本地 PDF**，扩展在本地解析出文本与结构，归一为 `PaperContent`，复用现有三条链路。
2. **论文解读**对 PDF 完整可用（这是最现实、最高价值的部分）。
3. **公式推导**在 PDF 下以「实验性」形态提供：抽取疑似公式区域的原始文本，交由 LLM 还原为 LaTeX 再推导，并明确标注可能不准。
4. **导出 Markdown**对 PDF 来源可用。

### 非目标（本次不做）

- 不做 `file://` 自动检测 Chrome 内置 PDF 阅读器内容（内置阅读器内容无法被 content script 访问；改用文件选择/拖拽）。
- 不接入外部数学 OCR / 云服务（成本与隐私考虑；符合用户此前「暂不引入外部端点」的约束）。
- 不做扫描版/图片型 PDF 的 OCR（无文本层的 PDF 直接提示不支持）。
- 不做 PDF 内的公式「回跳高亮」（无页面 DOM），Phase A 用「页码」代替定位。

---

## 2. 核心技术难点与结论

| 难点 | 结论 / 策略 |
|---|---|
| PDF 无 DOM、无法用 content script 抓取 | 在 **SidePanel 内**用 `pdfjs-dist` 直接解析用户选择的文件（SidePanel 是有完整 DOM 的扩展页）。 |
| pdf.js 的 worker 在 MV3 下的加载 | 用 Vite/WXT 的 `?url` 导入 worker 资源并设 `GlobalWorkerOptions.workerSrc`；必要时加入 `web_accessible_resources`。首选 `pdfjs-dist` 的 `legacy` 或 `.mjs` worker。 |
| PDF 只有带坐标的文本片段，无语义结构 | 自研**版面重建**：按 y 聚行、x 分栏、去页眉页脚、去连字符、合并段落、基于字号/编号识别标题。 |
| PDF 里没有 LaTeX（数学是字形） | **不追求完美**。Phase A：用数学字体名（CMMI/CMSY/CMEX/MSAM/STIX 等）+ 特殊 Unicode + 版面特征识别「疑似公式区域」，把原始（可能乱码）文本 + 上下文交给 LLM 还原 LaTeX 并推导，UI 标注「AI 识别，实验性」。 |
| 抽取质量天然弱于 arXiv HTML | 明确产品预期：PDF 是「兜底通道」，arXiv 仍是首选路径；`warnings` 里如实告知局限。 |

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

```
src/pdf/
  loadPdfjs.ts        配置并懒加载 pdfjs-dist（含 workerSrc 设置）
  types.ts            PDF 解析中间结构（TextItem/Line/Block/Column）
  textLayout.ts       版面重建：聚行 → 分栏 → 去页眉页脚 → 去连字符 → 合并段落
  structure.ts        标题/章节识别、摘要/参考文献切分、标题作者提取
  formulaHeuristic.ts 疑似公式区域识别（字体名 + Unicode + 版面特征）
  extractPdf.ts       主入口：ArrayBuffer → PaperContent（组合上面几步）

src/bridge/
  pdfSource.ts        SidePanel 侧：文件读入、内容 hash 生成稳定 key、缓存原始 bytes(仅内存)

entrypoints/sidepanel/
  PdfPicker.tsx（或并入 App）  文件选择 / 拖拽 UI
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

## 8. 公式启发式（formulaHeuristic.ts，Phase A 实验性）

1. **候选识别**：
   - block/行中数学字体占比高（`fontName` 含 `CMMI`/`CMSY`/`CMEX`/`MSAM`/`MSBM`/`STIX`/`Math`/`Symbol`）；
   - 或特殊 Unicode 数学符号密度高（∑∫∏√≤≥≈∞αβγ…下标上标）；
   - 或「居中短行 + 行尾带 `(n)` 编号」→ 判为 display 候选。
2. **产出**：每个候选生成一个 `Formula`：
   - `latex`：**放原始抽取文本**（可能乱码），并置 `confidence`；
   - `display`：由是否独立成行/带编号推断；
   - `page`：所在页；`context`：邻近正文；`sectionPath`：归属章节。
   - `formulaSupport = 'heuristic'`。
3. **推导时**：`pipelines/derive.ts` 需感知 `source==='pdf'`（或 `formulaSupport==='heuristic'`），改用一个「先还原 LaTeX 再推导」的 prompt 变体：告诉模型「以下是从 PDF 提取的疑似公式原始文本，可能含乱码/错位，请先推断其最可能的 LaTeX，再逐步推导」。UI 显著标注「AI 识别，可能不准」。

> 若 Phase A 效果不佳，可降级：PDF 下 `formulaSupport='none'`，公式推导 Tab 显示「本地 PDF 暂不支持公式抽取，请使用 arXiv 页面」。方案保留这个开关。

---

## 9. SidePanel 接入（App.tsx 等）

1. **来源切换**：当活动 tab 不是 arXiv（`supported===false`）时，`UnsupportedHint` 增加一个入口：「改用本地 PDF」。也可在 Header 常驻一个小的「打开 PDF」按钮。
2. **PdfPicker**：`<input type="file" accept="application/pdf">` + 拖拽区。选中后：
   - 读为 `ArrayBuffer`；算内容 hash（如 SHA-256 前 16 hex）生成合成 key：`pdf:<filename>:<size>:<hash>`。
   - 用这个 key 充当 `PageState.url`，`kind` 走一个新的分支（见下），标题用文件名或解析出的 title。
3. **PageState / classify 调整**：`PageState.kind` 目前是 `'abs'|'html'|'ar5iv'|'unknown'`。新增 PDF 需要让 `supported` 为真。两种做法（择一，推荐 A）：
   - **A（推荐）**：给 `PageState` 加 `source: 'arxiv'|'pdf'`，`supported = source==='pdf' || kind!=='unknown'`。PDF 时 `kind` 可设为占位。
   - B：把 `kind` 联合类型扩为含 `'pdf'`（改动面更大，波及多处 classify）。
4. **handleExtract 分支**：
   - `source==='arxiv'` → 现有 `requestExtractFromActiveTab()`；
   - `source==='pdf'` → 调用内存里保存的该文件 `ArrayBuffer`，跑 `extractPdf(buffer, key)`（在 SidePanel 内直接 `await`），得到 `PaperContent`。
5. **缓存**：`cache.ts` 已按 URL 缓存，PDF 用合成 key 天然复用（同一文件再次打开可恢复解读/推导）。**注意**：原始 `ArrayBuffer` 不进 `chrome.storage`（太大），只在内存保留；刷新 SidePanel 后若需重抽取，提示用户重新选文件（`PaperContent` 本身仍从 session 缓存恢复）。
6. **回跳降级**：`DerivationTab` 详情视图里，`source==='pdf'` 时把「回跳原文」替换为「第 N 页」的只读标注（`formula.page`），不发 `SCROLL_TO_FORMULA`。

---

## 10. 分阶段实施清单（建议提交粒度）

### Phase A — MVP（PDF → 解读 + 导出打通）
- [ ] `pnpm add pdfjs-dist`；`src/pdf/loadPdfjs.ts` 配好 workerSrc，能在 SidePanel 里解析出纯文本。
- [ ] `types.ts` 加 `source/formulaSupport/pageCount` + `Formula.page/confidence`（全可选）。
- [ ] `textLayout.ts` 版面重建（聚行/分栏/去页眉页脚/去连字符/段落）。
- [ ] `structure.ts` 标题/摘要/章节/参考文献识别 → `PaperContent`。
- [ ] `extractPdf.ts` 串起来；失败降级为整页纯文本 + `warnings`。
- [ ] `PdfPicker` + `App.tsx` 的 `source` 分支 + `handleExtract` PDF 分支 + 合成缓存 key。
- [ ] 验证：几篇真实 PDF（单栏/双栏）→ 论文解读可用、导出 `.md` 正常。
- [ ] 提交：`feat(pdf): 本地 PDF 文本抽取与论文解读打通（MVP）`。

### Phase B — 版面与结构增强
- [ ] 双栏检测、页眉页脚去除、连字符与段落合并的鲁棒性提升（用问题 PDF 回归）。
- [ ] 标题/作者/参考文献识别准确率提升。
- [ ] 提交：`feat(pdf): 增强双栏/页眉页脚/段落重建`。

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

> 参考 `docs/architecture.md` 与本文件。请从 Phase A 开始：先加 `pdfjs-dist` 并在 `src/pdf/loadPdfjs.ts` 跑通「选一个本地 PDF → 打印每页纯文本」，确认 worker 在 MV3 SidePanel 下正常，再依次实现 `textLayout → structure → extractPdf`，最后接 `App.tsx`。数据模型只加可选字段，保证 arXiv 路径零回归。每步跑 `pnpm compile`/`pnpm build`。遵循仓库规则：中文注释、UTF-8、async/await、完善错误处理，不改动与本功能无关的既有逻辑。
