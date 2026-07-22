# MinerU 薄集成 Epic A 验收报告

日期：2026-07-21
范围：`docs/plan-mineru-thin-integration.md` 的 A1–A3，仅本地 Python 服务；扩展产品路由尚未接入。

## 结论

Epic A 门禁通过，可以进入 B1；没有降低 P1，也没有跳过 65 条金标回归。服务固定为 `127.0.0.1:17860`、MinerU 3.4.4 `pipeline`、单并发。HTML/ar5iv、现有 PDF 解读和 Phase C 路由在 Epic A 中均未修改。

## A1：冻结契约与安全配置

- schema v1 覆盖 health、job status/result、稳定错误码和 0 展示公式的合法完成结果。
- 只允许 `127.0.0.1`，Bearer token 与 schema 版本均校验；token、PDF 名称、绝对路径和内部异常不进入响应。
- 冻结 200 MiB / 500 页、任务 30 分钟、result/crop 24 小时 TTL；输入在任务终态删除。
- wheel 包含运行代码和共享 schema；构建产物只写入已忽略的 `local-artifacts/`。

## A2：单任务 worker、状态与清理

- 提供 health、创建/查询/取消/删除 job；队列单并发且有界。
- 常驻受监管 MinerU API 子进程复用模型；取消或超时终止精确进程树。
- 真实阶段为 `queued → preparing → loading-model → parsing → normalizing → crops-ready → completed`；没有页百分比、当前页或按时间推算的进度。
- Windows 真实烟测：Attention 176.892 秒、ResNet 89.648 秒、BERT 106.618 秒；同一服务进程复用模型。
- Windows 取消复测：约 4.1 秒完成取消；input、raw、子进程和监听端口均无残留。

## A3：归一化、上下文与裁剪

- `content_list` 只把展示/编号公式写入列表；`middle` 中行内公式只计数。
- 每条公式生成稳定 ID、1-based page、0–1000 bbox、受控 crop ID、标题栈和前后邻近正文。
- 裁剪优先使用 MinerU 图片；引用只能落在当前 job raw 目录，图片格式/大小/像素受限。缺少图片时才从仍未删除的输入 PDF 按 bbox 本地渲染。
- `GET /v1/jobs/{jobId}/crops/{cropId}` 必须通过 Bearer 与 schema 校验，只返回 JPEG/PNG/WebP，不暴露文件路径。
- 只有规范化和全部裁剪准备完成后才原子发布 `completed + result`。缺失/冲突的 JSON、`middle` 页数不一致、非法页码/bbox、目录穿越或坏图片均返回 `RESULT_INVALID`；失败、取消和超时清理未完成 raw/crops。
- Attention/ResNet/BERT 接线结果分别为 `5 display + 108 inline`、`2 + 52`、`0 + 58`；BERT 的 0 展示公式是合法完成，不是失败。

## 65 条金标回归

评测保持 PDF-only、关闭 TeX 源捷径，并复用冻结的 65 条金标和 234 条人工候选审核。薄服务规范化结果与 POC B 的公式字段、行内计数及 234 张裁剪图字节完全一致。

| 指标 | 薄服务结果 | P1 门槛 |
|---|---:|---:|
| 展示公式区域召回率 | 96.9% | ≥92% |
| 公式区域精确率 | 99.6% | ≥85% |
| 完整且结构正确 | 96.9% | ≥85% |
| 裁剪完整率 | 96.9% | ≥95% |
| KaTeX 可渲染率 | 99.1% | ≥95% |
| 核心公式 | 4/4，通过 | 全部通过 |
| 文档失败 | 0/13 | 0 |

234/234 条结果均带 section、context 和 crop ID。已知上限保持不变：BatchNorm 的两个复杂多行块漏检，Adam 附录两个超长 array 有尾部截断；本轮没有用后处理伪装修复。

## 可复跑证据

```powershell
$env:PYTHONPATH = (Resolve-Path 'services/mineru/src').Path
& local-artifacts/pdf-ocr-poc/mineru-3.4.4/.venv312/Scripts/python.exe `
  -m unittest discover -s services/mineru/tests -v

& local-artifacts/pdf-ocr-poc/mineru-3.4.4/.venv312/Scripts/python.exe `
  services/mineru/examples/adapt_gold_corpus.py `
  --run local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high `
  --corpus tests/fixtures/pdf-ocr-corpus.json `
  --output local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/thin-predictions.json `
  --reference-predictions local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/predictions.json

node tests/phaseD.ocr-poc.mjs evaluate `
  --predictions=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/thin-predictions.json `
  --reviews=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/reviews.json `
  --output=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/thin-evaluation.md

pnpm test:phase-d:ocr-poc
pnpm compile
```

验证结果：Python 47/47、OCR POC 13/13、TypeScript 编译通过、wheel 构建通过。敏感信息扫描只命中测试中的显式假 token；PDF、模型、裁剪图、评测输出和 wheel 均位于 `.gitignore` 覆盖的 `local-artifacts/`。
