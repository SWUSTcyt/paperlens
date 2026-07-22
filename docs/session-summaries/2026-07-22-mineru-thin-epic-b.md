# Session 摘要：MinerU 薄集成 Epic B 收束

日期：2026-07-22
恢复来源：Codex session `019f7b38-08c7-7f93-b9d6-b7168b506795`

## 处理的 Issue

- 恢复上次中断的 B1–B4 实现与真实 MinerU 浏览器闭环。
- 修复浏览器原生 fetch 接收者、上传前 health 门禁、进度卡分支位置和 OCR 识别摘要缺字段。
- 校正浏览器测试对冻结数据模型的错误断言，并让浏览器命令自动构建最新产物。
- 完成 Epic B 全套验收、文档、敏感信息检查前准备与 GitHub 发布收尾。

## 使用的 Skill

- `execute-implement`：对照 B1–B4 P0/P1 修复实现。
- `verify-test`：单元、功能、真实浏览器与 65 条金标分层验收。
- `verify-review`：提交前按 P0–P3 输出 Review Packet。
- `observe-session`：更新 PLAN、验收报告、PR 摘要与本 Session 记录。
- `improve-retro`：把重复/非显然问题固化到 `docs/issues-log.md` 和浏览器测试命令。
- `github:yeet`：显式暂存本轮范围、提交、推送并创建草稿 PR。

## 关键错误与解法

1. **陈旧构建造成假等待**：`.output` 早于最新 `App.tsx`，源码有接线但浏览器产物没有。改为所有浏览器测试先自动 `pnpm build`。
2. **浏览器请求在网络前失败**：原生 fetch 被作为实例方法调用，Edge 抛 `Illegal invocation`。默认 fetch 改为绑定 `globalThis`，新增接收者测试。
3. **缺少 health 门禁**：provider 直接上传，无法在 job 前冻结 ready/版本证据。新增 health/schema/engine/ready 预检和失败不建 job 的测试。
4. **进度 UI 分支错误**：进度卡只在“不支持页面”分支渲染；移到主内容公共位置，上传 PDF 可见真实阶段/回退。
5. **识别摘要漏字段**：真实 5/108 已完成，但文档摘要没有 `displayFormulaCount`。补类型、合并和 0/非 0 单元断言。
6. **测试扩张模型**：E2E 错误要求 `PaperContent.recognitionSource`。TypeScript 阻止后，按 Spec 改为 `formulaRecognition.provider` + `Formula.recognitionSource`。

## 验证结果

- Python：47/47。
- MinerU client/provider：15/15。
- PDF：46/46。
- OCR POC：13/13。
- 65 条金标：P1 pass；召回 96.9%、精确率 99.6%、结构 96.9%、裁剪 96.9%、KaTeX 99.1%、核心 4/4、文档失败 0。
- 真实 MinerU Edge：Attention 5 展示 + 108 行内、page+bbox、章节关联、鉴权 crop、Adam、file、导出全过。
- Phase C Edge：arXiv `/abs`、`/html`、`/pdf`、网页真 LaTeX、上传/file、prompt 链全过。
- `pnpm compile`、`pnpm build`：通过。

## 返工与降质检查

- 有一次无效浏览器等待来自陈旧构建，已通过自动 build 消除重复条件。
- 后续三次浏览器门禁分别暴露 fetch 接收者、摘要缺字段和测试越界，属于不同契约缺口；均先补自动测试再修，没有降低 P0/P1。
- 未发生把 P0 降为 P2、跳过真实关键路径或以构建代替功能验证的标准滑坡。
- 当前环境未提供可读取的精确 token 计数，因此不伪造数值。

## 下一步

进入 Epic C：完善 Windows 从零安装/升级/卸载与故障排查，补取消、超时、服务缺失、TTL 后 crop 失效等发布级浏览器矩阵。
