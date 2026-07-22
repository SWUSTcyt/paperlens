# arXiv TeX 源优先、PDF 块回退：实施计划

状态：**等待用户确认，尚未开始编码**
依赖：Phase C 阶段 2（commit `0b8360943eb510f0633fe0b11eb83b1758d07793`）

## 1. 设计结论

### 1.1 适用范围与优先级

```text
arXiv HTML / ar5iv ───────────────> 现有 DOM 真 LaTeX（保持不变）
可识别 arXiv ID 的 PDF ─> PDF 正文提取 ─┬─> arXiv 同版本 TeX 源成功：源公式
                                         └─> 获取/解析失败：Phase C PDF 公式块
其他远程、本地、上传 PDF ───────────────> Phase C PDF 公式块（保持不变）
```

- 源获取由 `src/bridge/pdfSource.ts` 一侧编排；`extractPdf` 继续只负责给定字节的本地 PDF 解析。
- 从 PDF URL 保留 `vN` 版本用于源请求；现有基础 `arxivId` 兼容不变。
- 源公式仅在项目解析可靠且至少产出一个有效公式时接管。零结果、异常或超限均不清空启发式结果。

### 1.2 能力与来源分离

建议新增向后兼容的来源字段，而不扩大 `formulaSupport` 的含义：

```ts
type FormulaOrigin = 'dom-latex' | 'arxiv-source' | 'pdf-heuristic' | 'none'
```

- `arxiv-source` 的 `formulaSupport` 仍为 `latex`，使用标准 LaTeX 渲染、导出和推导提示。
- 旧缓存缺少来源字段时，由 `source + formulaSupport` 推断旧行为。
- 源公式不设置无法证明的 `page` 或 DOM `anchor`；UI 不提供虚假“回跳原文”。公式可保留独立的 TeX 文件与行号诊断信息，但不暴露成本地路径。

### 1.3 安全与资源边界

- 只请求 arXiv 官方 `https://arxiv.org/src/{idvN}` 同版本源；`credentials: omit`，支持超时和取消。
- 归档只在内存处理；首版按魔数识别 gzip、tar 或纯 TeX，使用浏览器 `DecompressionStream('gzip')` 与严格的有界 tar reader。运行环境不支持所需解压能力时直接回退 PDF，不新增外部服务。
- 拒绝绝对路径、`..` 穿越、NUL、符号链接和硬链接；限制压缩体积、解压总体积、单文件体积、文件数与递归深度。
- 建议首版默认值：下载 25 MiB、解压合计 64 MiB、单文本 8 MiB、2,000 文件、include 深度 32、请求 15 秒。实现时集中为常量并覆盖边界测试，真实语料若需要调整必须提供证据。

## 2. TeX 解析边界

1. 以 `\documentclass`、`\begin{document}`、文件引用关系和常见入口名确定主文件；无法唯一确定时返回明确降级原因。
2. 按文档顺序解析本地 `\input` / `\include`，限制根目录、深度和环路；缺失的可选子文件记录警告，不读取归档外内容。
3. 先屏蔽注释和 `verbatim`、`lstlisting`、`minted` 等非正文环境，再做平衡定界解析，避免用单个正则吞整篇源码。
4. 抽取 `$...$`、`\(...\)`、`\[...\]`，以及 `equation`、`align`、`gather`、`multline`、`eqnarray` 的星号/非星号变体；保留 `\label` 和文档顺序。
5. 跟踪 `section/subsection/subsubsection`，用规范化后的精确标题合并到 PDF 章节；无法可靠匹配的公式进入“其他公式”，不做激进模糊归类。
6. 只收集无参数或固定参数数目的简单 `newcommand/renewcommand/def`，设数量和展开深度上限。把安全宏表传给 KaTeX；未知或复杂宏保留原文并触发现有代码块回退，不执行宏。

## 3. Epic、里程碑与 Issue

### Epic A：来源契约与安全获取

#### A1. 版本化来源与数据契约

- 输入：当前 PDF URL、`PaperContent` / `Formula` 类型、现有 URL 识别逻辑。
- 输出：版本化 arXiv 引用、`FormulaOrigin`、结构化源解析结果/降级原因、缓存 schema 版本。
- 依赖：无。
- P0：旧内容可兼容读取；HTML/ar5iv 分支不改变；不把 source origin 当成可回跳位置。
- P1：覆盖新旧式 arXiv ID、带/不带版本、查询参数和非 arXiv URL 单测。
- P2：降级原因使用稳定枚举，可供日志和 UI 消费。
- P3：在架构文档记录能力与来源正交的约定。

#### A2. 受限下载与安全归档读取

- 输入：A1 的版本化引用与 `AbortSignal`。
- 输出：只含获准文本文件的内存 TeX 项目；失败返回结构化原因。
- 依赖：A1。
- P0：路径穿越、链接、压缩炸弹、超时、非预期内容类型和各类超限均安全失败；不执行或写出文件。
- P1：正常 tar.gz、TeX.gz、未压缩 tar/TeX、404/403、损坏归档、取消请求均有测试。
- P2：记录耗时、压缩/解压字节、文件数，日志不含论文正文。
- P3：限制值集中配置并附调整说明。

### Epic B：确定性 TeX 项目解析

#### B1. 项目入口与 include 图解析

- 输入：A2 的文本文件映射。
- 输出：按文档顺序排列的 TeX 片段及文件/行号来源。
- 依赖：A2。
- P0：只访问项目内文件；include 环路、深度超限、歧义入口可预测地降级。
- P1：多文件、嵌套目录、注释掉的 include、缺失子文件、多个候选入口有夹具测试。
- P2：保留足够诊断信息，不把本地或临时路径写入模型提示。
- P3：入口评分规则文档化。

#### B2. 章节、公式与安全宏抽取

- 输入：B1 的有序 TeX 片段。
- 输出：含 LaTeX、display、sectionPath、context、label、source location、macro map 的公式列表。
- 依赖：B1。
- P0：平衡定界；跳过注释/代码环境；无灾难性正则回溯；结果设数量与长度上限。
- P1：覆盖内联/展示/多行环境、嵌套大括号、转义符、标签、章节、自定义简单宏和复杂宏回退。
- P2：每个拒绝或降级原因可统计；解析相同输入结果稳定。
- P3：保留原始公式 token，便于后续改解析器而无需重新下载 PDF。

### Epic C：管线集成与产品呈现

#### C1. 源优先合并与确定性回退

- 输入：现有 `extractPdf` 结果与 B2 源结果。
- 输出：最终 `PaperContent`；源成功时使用源公式，否则保留原启发式公式。
- 依赖：A1、B2。
- P0：源端任意失败不得阻断 PDF 正文/摘要；不得把空源结果覆盖非空启发式结果；非 arXiv PDF 完全不发源请求。
- P1：Attention/ResNet 核心公式完整；章节只做可靠匹配；并发获取不造成取消或进度竞态。
- P2：缓存 key/schema 包含提取版本，旧 Phase C 缓存不会掩盖新路径。
- P3：源获取可通过单一开关停用，回滚后自动使用现有 Phase C 行为。

#### C2. UI、推导、导出与可观测性

- 输入：带 `formulaOrigin` 的最终内容。
- 输出：来源徽标、合理操作、正确 prompt、Markdown 和进度/警告。
- 依赖：C1。
- P0：`arxiv-source` 不显示 DOM 回跳或伪造 PDF 页码；`pdf-heuristic` 继续显示实验性提示和“先还原”路径。
- P1：源公式使用标准推导 prompt；KaTeX 接受安全宏表，失败继续代码块展示；导出注明公式来源。
- P2：显示“尝试 TeX 源/已回退”的短提示，详细原因只进入诊断日志。
- P3：来源提示文案不宣称已与 PDF 版面逐页对齐。

### Epic D：分层验收与交付

#### D1. 自动测试、真实语料与浏览器验收

- 输入：A-C 全部结果与 Phase C 同一 13 篇 PDF。
- 输出：单元/功能/使用示例三层测试、前后报告、文档和人工验收清单。
- 依赖：C2。
- P0：`pnpm compile`、相关测试、`pnpm build` 全通过；恶意归档测试通过；HTML/ar5iv 与非 arXiv PDF 回归通过。
- P1：Attention 的 `softmax(QK^T/√d_k)V` 与 FFN、ResNet 核心编号公式以完整源块呈现；源公式不进入还原 prompt。
- P2：13 篇逐篇报告 source fetch、project parse、公式数、KaTeX 可渲染率、回退原因；建议目标为至少 12/13 成功解析源码项目、已抽取公式中至少 90% 可直接渲染。论文源码本身无数学公式时不制造结果，并单列说明。
- P3：真实 Edge 关键路径检查远程 arXiv PDF、上传 PDF、非 arXiv PDF、源损坏回退；无法自动化的项目明确标为待人工。

## 4. 开发顺序与提交边界

1. A1：先冻结类型、状态机、错误枚举和测试样例；不接网络。
2. A2：完成安全获取与归档夹具，单独审查攻击面。
3. B1-B2：先测试后解析；用最小 TeX 夹具和真实源快照验证，不接 UI。
4. C1：接入桥接层并验证成功/失败两条路径；保留 Phase C 作为唯一回退。
5. C2：更新 UI、推导、导出、缓存和文档。
6. D1：跑 13 篇语料、浏览器烟测、compile/build，再决定是否发布。

建议每个 Epic 至少一个独立 conventional commit；安全归档与解析器不要混在同一提交。任何一步触发 P0 失败即停止向下实施，不以降低标准换取完成。

建议模块边界：新增 `src/arxiv/id.ts` 统一基础 ID/版本解析，现有 `parseArxivId` 委托它以保持兼容；`src/arxiv/source.ts` 负责受限请求；新增 `src/tex/archive.ts`、`src/tex/project.ts`、`src/tex/formulas.ts`；`src/bridge/pdfSource.ts` 只负责编排；`src/pdf/extractPdf.ts` 与 `src/pdf/formulaHeuristic.ts` 不承担网络或 TeX 解析。

## 5. 回滚与停止条件

- 运行时开关可完全跳过源请求；关闭后行为等同已推送的 Phase C 阶段 2。
- 缓存按 schema 隔离，回滚不会读取不兼容记录。
- 若 13 篇中源码项目解析成功少于 12 篇，或核心公式仍依赖模型补全，停止产品接入，保留独立解析实验并重新评估，不回头继续堆 PDF 启发式。
- 若自定义宏使直接渲染率低于 90%，先报告失败类别与可选处理方式；不擅自引入 TeX 编译、OCR 或外部云服务。

## 6. 需要确认的决策

批准实施即视为同意以下首版边界：

1. 只支持可从 PDF URL 确定 ID/版本的 arXiv 文档，不扩展 `/abs` 页面或通用 DOI 找源。
2. 不做 TeX 公式到 PDF 页码/坐标的对齐，因此源公式没有 PDF 跳转。
3. 采用上述资源上限作为初值；若真实样本超过限制，只提交证据和调整建议后再改。
4. 以“13 篇项目解析 ≥12、已抽取公式 KaTeX 可渲染率 ≥90%、核心样本精确通过”作为首版 P1/P2 门槛。
5. 不执行 TeX，不引入 OCR 或云服务；复杂宏保留原文并可视降级。
