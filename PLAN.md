# PaperLens Phase C

目标：仅实现 PDF 实验性公式识别与推导；保持 Phase A/B 与网页真 LaTeX 路径不变。

- **C1 候选与门禁**（完成）：数学字体、Unicode 密度、居中编号行三类候选；普通正文/短噪声不误报。候选输出原始文本、`page/confidence/display/context/sectionPath`；无可靠候选或质量差时保持 `formulaSupport='none'`。
- **C2 PDF 接入**（完成）：公式 ID 从 1 起并写入所属 `Section.formulaIds`；任何候选识别异常只告警并降级，不影响正文、解读与导出。
- **C3 推导与 UI**（完成）：仅 heuristic 来源使用“先还原 LaTeX 再推导”prompt；显著标注“AI 识别，实验性”，原文定位降级为“第 N 页”；网页公式继续真实 LaTeX prompt 与 DOM 回跳。
- **C4 验收**（完成）：25 项 PDF 测试、`compile`、`build` 与真实 Edge 冒烟通过；diff/敏感信息/P0-P1 审查无阻塞项。真实 Provider 教学质量需用户配置 Key 后人工评估。

P0：不破坏网页公式、PDF 无候选时不伪造、失败不阻断解读。P1：元数据、prompt 分流、UI 标识/页码和三层测试齐全。P2：阈值后续按更多论文调优。P3：公式区域截图/OCR 不在本期。
