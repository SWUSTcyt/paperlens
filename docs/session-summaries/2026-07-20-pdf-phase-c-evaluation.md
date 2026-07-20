# Session 摘要：PDF Phase C 评估与有限优化

- 状态：`in-review / 等待阶段 3 路线确认`
- Skills：`plan-breakdown`、`verify-test`、`execute-implement`、`verify-review`、`observe-session`
- Token：目标记录约 90k（含阶段 1、真实语料输出与工具日志）

## 完成

- 13 篇真实 PDF、196 页基线；报告残缺、门禁与 LLM 掩盖问题。
- TDD 实现同栏/视觉带多行块、栏中心和编号锚点；保留诊断源行。
- 同语料前后：编号代理 20%→75%，残缺风险 77%→52%，ResNet 恢复，BERT 避免枚举误报，Attention/FFN 块完整度改善。
- 达到停止线条件：风险仍高于 45%，停止叠加启发式并给出四条阶段 3 路线。

## 错误与解法

- 初版栏中心把 BERT `(1)(2)(3)` 枚举当公式；增加失败用例，要求编号同时具备数学证据后修复。
- pdf.js 在 Node 诊断中只暴露通用/混淆字体名，数学字体信号仍不可用；未用更多正则掩盖。
- 编号代理不是人工真值；报告保留该限制，并以 BERT 误报说明不能只追召回数字。

## 验证

- 29/29 PDF tests、`pnpm compile`、`pnpm build`、真实 Edge Phase C smoke 全通过。
- 无 API Key、`.env`、OCR/云服务、commit 或 push。

## 降质检测

- Review 轮次正常；BERT 边界一次失败后由测试收口。
- 无 P0 标准滑坡；风险停止线失败后已停止实现。
