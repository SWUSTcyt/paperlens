# PaperLens MinerU 本地服务

该目录承载 PaperLens 的本地 MinerU 3.4.4 `pipeline` 薄服务。当前 **Epic A（服务）、Epic B（扩展接入）与 Epic C（Windows 完整生命周期和发布门）均已通过 P0/P1**：HTTP job、真实状态、取消/超时、进程清理、结果归一化、受控裁剪端点、扩展内确定性回退，以及 Windows 隔离安装、升级/修复、两种卸载和脱敏诊断均已落地。

A2/A3 提供 `/v1/health`、`POST/GET/DELETE /v1/jobs`、`POST /v1/jobs/{id}/cancel` 和 `GET /v1/jobs/{id}/crops/{cropId}`。服务对外固定监听 127.0.0.1；内部监督一个常驻 MinerU API 子进程以复用模型。MinerU 3.4.4 没有稳定页级状态 API，因此 `parsing` 只报告真实阶段与耗时，不返回推算页百分比。

成功结果只收录展示/编号公式；行内公式只写入 `inlineFormulaCount`。每条展示公式返回 1-based `page`、0–1000 `bbox`、受控 `cropId`、真实标题栈和邻近正文。缺页、冲突 JSON、越界坐标、非法图片路径或坏图片会使整份结果以 `RESULT_INVALID` 失败，不交付半份数据。

## Windows 安装与生命周期（C1/C2）

需要 Windows PowerShell 5.1+、[uv](https://docs.astral.sh/uv/) 和足够的模型磁盘空间。安装入口让 uv 使用隔离的 Python 3.12，不读取或修改全局 Anaconda/CUDA。首次安装及首次任务会下载/载入 MinerU 模型，可能耗时数分钟；不要把模型、配置或任务目录放进 Git。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File services/mineru/scripts/install-windows.ps1
```

安装器在 `%LOCALAPPDATA%\PaperLens\MinerU\runtime` 创建带标记的版本化运行时和 `paperlens-mineru.cmd` 启动器。候选运行时通过 `init`、`check-config`、`doctor`、安全停服与端口释放检查后才切换；重复运行同一命令即执行升级或同版本修复，失败时保留上一个可用运行时。安装器拒绝覆盖没有 PaperLens 标记的目录，也不会删除配置或任务数据。

`init` 默认创建 `%LOCALAPPDATA%\PaperLens\MinerU\paperlens-mineru.toml`，并只显示一次随机 token。不要把首次安装输出重定向到公开日志；把 token 填入 PaperLens 设置页的“本地 MinerU 公式识别”，先点“测试连接”，成功后再启用。服务固定监听 `127.0.0.1:17860`；不要改成局域网或公网地址。

### 使用示例

首次安装或幂等重装使用同一条命令：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File services/mineru/scripts/install-windows.ps1
```

离线诊断配置、Python、MinerU、端口、运行时和磁盘占用；输出可分享，不含 token 或绝对路径：

```powershell
& "$env:LOCALAPPDATA\PaperLens\MinerU\runtime\paperlens-mineru.cmd" doctor
```

启动服务后执行 health 与扩展 TypeScript client 的关键路径验收：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File services/mineru/examples/verify_windows_install.ps1
```

安装器和 `doctor` 会报告真实 `installSeconds`、`runtimeBytes`、`dataBytes` 与 `modelCacheBytes`。未发现模型缓存时只给出提示，不把首次任务尚未下载模型误报为安装失败。

安全停止服务（状态文件不含 token；进程身份不完全匹配时拒绝误杀）：

```powershell
& "$env:LOCALAPPDATA\PaperLens\MinerU\runtime\paperlens-mineru.cmd" stop
```

默认卸载只删除运行时，保留配置、token、任务和 `%LOCALAPPDATA%\PaperLens\MinerU\models` 下的专用模型缓存：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File services/mineru/scripts/uninstall-windows.ps1
```

完整清理必须同时提供开关和精确确认短语：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File services/mineru/scripts/uninstall-windows.ps1 `
  -PurgeData `
  -ConfirmPurge "DELETE PAPERLENS MINERU DATA"
```

真实生命周期验收会从一个不存在的仓库内目录开始，并依次执行修复、保留卸载、重装和完整清理：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File services/mineru/examples/verify_windows_lifecycle.ps1 `
  -WorkRoot "$PWD\local-artifacts\mineru-c2-lifecycle"
```

不要手动删除运行时、配置、模型或任务目录。系统级后台服务与自动更新属于 P3 follow-up，当前版本不提供。

若用户显式用 `MODELSCOPE_CACHE` 或 `HF_HOME` 指向数据根目录之外的共享缓存，完整清理不会删除该外部目录，避免影响其他程序；需要由目录所有者另行清理。

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

默认存储根目录是 `%LOCALAPPDATA%\PaperLens\MinerU`，任务和模型分别位于其下的 `jobs/` 与 `models/`。配置按“代码默认值 → TOML → 环境变量”覆盖，但引擎、并发和安全上限在 schema v1 中冻结。

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
