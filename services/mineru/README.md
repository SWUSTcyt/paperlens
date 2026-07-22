# PaperLens MinerU 本地服务

该目录承载 PaperLens 的本地 MinerU 3.4.4 `pipeline` 薄服务。当前 **Epic A（服务）与 Epic B（扩展接入）均已通过门禁**：HTTP job、真实状态、取消/超时、进程清理、结果归一化、受控裁剪端点，以及扩展内的确定性回退、进度/取消 UI 和 OCR 推导隔离均已落地。

A2/A3 提供 `/v1/health`、`POST/GET/DELETE /v1/jobs`、`POST /v1/jobs/{id}/cancel` 和 `GET /v1/jobs/{id}/crops/{cropId}`。服务对外固定监听 127.0.0.1；内部监督一个常驻 MinerU API 子进程以复用模型。MinerU 3.4.4 没有稳定页级状态 API，因此 `parsing` 只报告真实阶段与耗时，不返回推算页百分比。

成功结果只收录展示/编号公式；行内公式只写入 `inlineFormulaCount`。每条展示公式返回 1-based `page`、0–1000 `bbox`、受控 `cropId`、真实标题栈和邻近正文。缺页、冲突 JSON、越界坐标、非法图片路径或坏图片会使整份结果以 `RESULT_INVALID` 失败，不交付半份数据。

## Windows 安装与启动（源码版）

需要 Windows、Python 3.12、[uv](https://docs.astral.sh/uv/) 和足够的模型磁盘空间。首次安装及首次任务会下载/载入 MinerU 模型，可能耗时数分钟；不要把模型、配置或任务目录放进 Git。

```powershell
uv venv services/mineru/.venv --python 3.12
uv pip install --python services/mineru/.venv/Scripts/python.exe -e services/mineru
& services/mineru/.venv/Scripts/paperlens-mineru.exe init
& services/mineru/.venv/Scripts/paperlens-mineru.exe check-config
& services/mineru/.venv/Scripts/paperlens-mineru.exe serve
```

`init` 默认创建 `%LOCALAPPDATA%\PaperLens\MinerU\paperlens-mineru.toml`，并只显示一次随机 token。把 token 填入 PaperLens 设置页的“本地 MinerU 公式识别”，先点“测试连接”，成功后再启用。服务固定监听 `127.0.0.1:17860`；不要改成局域网或公网地址。

停止服务可在运行窗口按 `Ctrl+C`。卸载源码 venv 时，只删除 `services/mineru/.venv`；任务/模型数据位于 `%LOCALAPPDATA%\PaperLens\MinerU`，是否清理由用户单独决定。更完整的升级、卸载与故障排查矩阵属于 Epic C。

## 冻结默认值

| 配置 | 值 |
|---|---|
| 监听地址 | `127.0.0.1:17860`，拒绝 `0.0.0.0` 和远程主机 |
| 引擎 | MinerU `3.4.4` / `pipeline` |
| 并发 | 1 |
| PDF 上限 | 200 MiB / 500 页 |
| 单任务超时 | 1800 秒 |
| result/crop TTL | 86400 秒 |
| 任务输入 | 进入终态时删除 |

默认存储根目录是 `%LOCALAPPDATA%\PaperLens\MinerU`。配置按“代码默认值 → TOML → 环境变量”覆盖，但引擎、并发和安全上限在 schema v1 中冻结。

## A1 配置示例

```toml
[server]
host = "127.0.0.1"
port = 17860

[auth]
# 使用 examples/generate_token.py 生成，勿提交真实值。
token = "replace_with_a_generated_url_safe_token"

[storage]
root = "C:/Users/you/AppData/Local/PaperLens/MinerU"
```

可覆盖项：

- `PAPERLENS_MINERU_HOST`：只能是 `127.0.0.1`。
- `PAPERLENS_MINERU_PORT`：`1024–65535`。
- `PAPERLENS_MINERU_TOKEN`：至少 32 位 URL-safe 随机字符串。
- `PAPERLENS_MINERU_DATA_ROOT`：绝对路径。

未知的 `PAPERLENS_MINERU_*` 环境变量会被拒绝，防止拼写错误静默生效。配置对象的 `repr`、安全诊断和 API 错误均不会输出 token。

## 契约

共享 JSON Schema 位于 `schemas/v1/`：

- `health.schema.json`
- `job-status.schema.json`
- `job-result.schema.json`
- `error.schema.json`

结果契约只允许 MinerU 3.4.4 pipeline；公式 bbox 是 `[x0,y0,x1,y1]` 的 0–1000 整数坐标。响应不得包含本地绝对路径或未知字段。展示公式为 0 是合法完成结果，必须与协议损坏或服务失败区分。

稳定错误码：

| 类别 | 错误码 |
|---|---|
| 认证/配置 | `AUTH_REQUIRED`、`AUTH_INVALID`、`CONFIG_INVALID` |
| 协议 | `VERSION_INCOMPATIBLE`、`INVALID_REQUEST`、`RESULT_INVALID` |
| PDF | `PDF_INVALID`、`PDF_TOO_LARGE`、`PDF_TOO_MANY_PAGES` |
| 服务/job | `SERVICE_NOT_READY`、`QUEUE_FULL`、`JOB_NOT_FOUND`、`JOB_FAILED`、`JOB_CANCELLED`、`JOB_TIMED_OUT` |
| 兜底 | `INTERNAL_ERROR` |

## 运行服务测试

使用 POC 验证过的隔离 Python 3.12，避免系统 Anaconda DLL 污染：

```powershell
$env:PYTHONPATH = (Resolve-Path 'services/mineru/src').Path
python -m unittest discover -s services/mineru/tests -v
```

测试覆盖配置优先级、固定 localhost、安全 token、正常/空公式结果、非法 bbox/页码/路径、版本不兼容、认证失败、状态机、取消/超时、结果原子发布和裁剪鉴权。

65 条金标重放：

```powershell
$env:PYTHONPATH = (Resolve-Path 'services/mineru/src').Path
python services/mineru/examples/adapt_gold_corpus.py `
  --run local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high `
  --corpus tests/fixtures/pdf-ocr-corpus.json `
  --output local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/thin-predictions.json `
  --reference-predictions local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/predictions.json
```

脚本只在已忽略的 `local-artifacts/` 下生成规范化结果和裁剪图。Epic A 的完整验收证据见 `docs/evaluations/mineru-thin-epic-a.md`。

## 示例

```powershell
$env:PYTHONPATH = (Resolve-Path 'services/mineru/src').Path
python services/mineru/examples/generate_token.py
python services/mineru/examples/validate_result.py services/mineru/tests/fixtures/job-result.valid.json
python services/mineru/examples/validate_result.py services/mineru/tests/fixtures/job-result.zero-display.json
```

生成的 token 只应放在用户本机配置或环境变量中，不得写入仓库。
