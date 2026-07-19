# Session：PDF Phase C 实验性公式

- Issues：C1 候选与质量门禁、C2 PDF/章节接入、C3 heuristic prompt 与 UI/页码、C4 分层验收均完成实现。
- Skills：`plan-breakdown` → `verify-test` + `execute-implement` → `verify-review` → `observe-session`。
- 产出：`formulaHeuristic.ts`，PDF 字体/公式元数据接入，来源隔离 prompt，实验性 UI 与来源感知 Markdown 导出，8 项新增 Node 测试和 Phase C 浏览器模式。
- 验证：25 项 PDF 测试、`pnpm compile`、`pnpm build`；Edge 实测 arXiv HTML 真 LaTeX 隔离、Attention 3 条真实候选及元数据/章节关联、页码 UI，并用浏览器内模拟 Port 验证 prompt 与流式结果链。
- 错误与解法：Node 原生 TS 不解析无扩展名运行时导入，改为候选模块接受标题判定器，生产注入完整实现；CDP 激活模拟 SidePanel 会改变活动 tab，改为直接操作调试目标；Markdown 原先会把 PDF 原文包成 LaTeX，补来源分支与回归测试。
- 质量信号：无标准滑坡；浏览器截图确认原始 PDF 文本可能缺字，因此保留强实验性提示和保守门禁。Token 预算未设置。
- 待人工：临时浏览器 profile 无 API Key，真实 Provider 的 LaTeX 还原与教学质量需用户配置 Key 后评估；不影响代码路径与 prompt 传递验收。
