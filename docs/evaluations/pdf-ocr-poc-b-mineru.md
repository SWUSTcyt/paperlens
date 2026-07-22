# PDF OCR POC B：MinerU 评测报告

日期：2026-07-21

## 结论

MinerU 3.4.4 的本地 `pipeline` 后端在冻结的 PDF-only 基准上通过 P1：13 篇、196 页全部完成，65 条金标召回 63 条；人工逐图确认 63 条命中公式的结构与裁剪均完整。234 个候选经 contact sheet 全量审核，233 个是真实展示公式。评测全程 `texSourceShortcut=false`，没有读取 TeX、作者 HTML、`references/` 或 `source-archives/`。

这证明“任意上传 PDF → 本地 Python 解析 → 展示公式与裁剪图”的薄集成路线可行，但不表示识别无缺陷，也不授权产品接入。BatchNorm 的两个复杂多行块仍漏检，两个 Adam 附录长数组虽检测到区域却输出截断 LaTeX。按冻结决策门，POC C（Paddle）不触发；下一步必须先由用户单独批准薄集成。

## 冻结范围与 P1 裁决

| 指标 | 结果 | 门槛 | 裁决 |
|---|---:|---:|---|
| 展示公式区域召回 | 63 / 65（96.9%） | ≥92% | 通过 |
| 区域精确率 | 233 / 234（99.6%） | ≥85% | 通过 |
| 结构完整正确 | 63 / 65（96.9%） | ≥85% | 通过 |
| 裁剪完整 | 63 / 65（96.9%） | ≥95% | 通过 |
| KaTeX 可渲染 | 232 / 234（99.1%） | ≥95% | 通过 |
| Attention / ResNet 核心公式 | 4 / 4 | 全部通过 | 通过 |
| 文档失败 | 0 / 13 | 0 | 通过 |
| P1 总裁决 |  |  | **pass** |

精确率使用全部 234 个候选的人工有效性审核。65 条金标是召回/完整度抽样，不是 13 篇的全量公式清单；若把未出现在抽样金标中的真实公式算作误报，会得到错误的精确率。阈值和 65 条金标均未改变。

人工审核材料位于忽略目录：

- `local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/review.html`
- `local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/review-sheets/`
- `local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/reviews.json`
- `local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/evaluation.md`

这些本地文件包含 PDF 裁剪或运行结果，不提交 Git。

## 关键证据与上限

1. Attention 的 softmax (1) 与 FFN (2) 均从 PDF 图面完整识别，包含可用 LaTeX、0–1000 坐标和本地公式裁剪图；不依赖模型记忆还原。
2. ResNet 两条核心式全部命中且结构完整。BERT 整篇处理成功，得到 58 个行内公式、0 个展示公式；它是“已解析但展示列表为空”，不是文档级 `none`。
3. BatchNorm 的单行式 BN-1、BN-2、BN-3 命中；算法框中的四行归一化块 BN-4 与下一页多行反向传播块 BN-5 完全漏检。这两条按召回、结构和裁剪失败计分。
4. Adam 附录的两个超长数组候选（`p13-e22`、`p14-e30`）区域检测正确，但 LaTeX 在 `\end{array}` 前截断，KaTeX 无法渲染。说明 pipeline 对超长多行推导仍有明显上限。
5. 唯一候选误报是 Neural ODE 页 13 的纯文字 “by L'Hôpital's rule”；其余 233 个候选均为真实展示公式区域。
6. 引擎共报告 2,922 个行内公式，仅计入正文结构统计，没有塞进 P1 推导列表。

## 实测环境

| 项目 | 实测值 |
|---|---|
| 系统 | Windows `10.0.26200` |
| CPU | Intel Core i7-12700H，20 逻辑核 |
| 内存 | 32 GiB；正式运行开始时空闲约 5.87 GiB |
| GPU | NVIDIA RTX 4070 Laptop，8,188 MiB；驱动 528.76 |
| Node | 24.12.0 |
| uv | 0.8.11 |
| Python | uv 管理 CPython 3.12.11 |
| MinerU | 3.4.4 |
| pipeline 运行时 | ONNX Runtime 1.27.0，CPU provider |
| PyTorch | 2.8.0+cpu，`torch.cuda.is_available() == false` |
| 模型源 | ModelScope，本地磁盘 |
| 云服务 / Key | 无 |

官方说明中，MinerU 支持 Python 3.10–3.12；`pipeline` 是 CPU 可用后端，公式识别默认开启。Windows 本机选择 3.12 是为了避开已有 Anaconda 3.10 的旧 VC Runtime DLL 污染，而非产品强制要求。

## Windows 从零安装与复跑

以下命令在 PowerShell 执行；Git 操作仍应使用 Git Bash。本 POC 不需要 Docker、云 OCR 或 Key。

```powershell
# 1. 安装 uv（也可按 uv 官方文档选择其他安装方式）
winget install --id astral-sh.uv -e
uv --version

# 2. 在项目的已忽略目录创建完全隔离的 Python
$pocRoot = (Resolve-Path 'local-artifacts/pdf-ocr-poc').Path + '\mineru-3.4.4'
$env:UV_PYTHON_INSTALL_DIR = "$pocRoot\python"
$env:UV_CACHE_DIR = "$pocRoot\uv-cache"
uv python install 3.12
uv venv "$pocRoot\.venv312" --python 3.12

# 3. 安装冻结版本；跨磁盘时显式 copy，避免 hardlink 警告
uv pip install --link-mode=copy `
  --python "$pocRoot\.venv312\Scripts\python.exe" `
  'mineru[all]==3.4.4'

# 4. 把配置、缓存和模型全部限制在本地忽略目录
$env:HF_HOME = "$pocRoot\models\huggingface"
$env:MODELSCOPE_CACHE = "$pocRoot\models\modelscope"
$env:MINERU_MODEL_SOURCE = 'modelscope'
$env:MINERU_TOOLS_CONFIG_JSON = "$pocRoot\mineru.json"
& "$pocRoot\.venv312\Scripts\mineru-models-download.exe" `
  --source modelscope --model_type pipeline
& "$pocRoot\.venv312\Scripts\mineru.exe" --version

# 5. 准备冻结 PDF；不会把 PDF 放进 Git
node tests/phaseD.ocr-poc.mjs prepare `
  --artifacts=local-artifacts/pdf-ocr-poc

# 6. 常驻一个本地 API，按论文顺序处理并逐篇 checkpoint
pnpm poc:mineru:run -- `
  --mineru-root=local-artifacts/pdf-ocr-poc/mineru-3.4.4 `
  --backend=pipeline --effort=high --port=18081

# 7. 归一成统一预测格式，生成审核模板与本地审核页
pnpm poc:mineru:adapt -- `
  --run=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high
pnpm poc:mineru:review -- `
  --predictions=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/predictions.json

# 8. 人工审核后执行正式门禁
node tests/phaseD.ocr-poc.mjs evaluate `
  --predictions=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/predictions.json `
  --reviews=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/reviews.json `
  --output=local-artifacts/pdf-ocr-poc/mineru-3.4.4/run-pipeline-high/evaluation.md
```

`runMineruPoc.mjs` 固定 `texSourceShortcut=false`、`formula=true`，支持已完成论文复用、单篇超时、逐篇 manifest 和 Windows API 进程树清理。`--effort=high` 对 pipeline 不改变模型，仅保持与 hybrid 命令接口一致。

## 安装、冷启动与磁盘

| 项目 | 实测耗时 | 说明 |
|---|---:|---|
| 首次错误安装到系统 Anaconda 3.10 | 187.57 s | 154 包；ONNX Runtime DLL 导入失败 |
| 尝试固定 ONNX Runtime 1.22.1 | 15.12 s | 相同 DLL 失败，证明不是单一 wheel 版本 |
| 下载 uv CPython 3.12.11 | 130.36 s | 完全隔离于 Anaconda |
| 安装 `mineru[all]==3.4.4` | 130.42 s | 148 包；命令可用 |
| pipeline 首页冷烟测 | 223.19 s | 包含 pipeline 模型下载与初始化 |
| 13 篇正式处理 | 3,052.36 s | 50.87 min；平均 15.57 s/页 |
| hybrid/high 单页失败烟测 | 387.29 s | 含本地 VLM 下载；CUDA 不可用 |

| 本地项目 | 占用 | 是否运行必需 |
|---|---:|---|
| 成功的 `.venv312` | 2.181 GiB | 是 |
| uv CPython 3.12.11 | 0.059 GiB | 是 |
| pipeline 模型 | 1.008 GiB | 是 |
| pipeline 最小运行合计 | **约 3.25 GiB** | 是 |
| 13 篇输出、图片与日志 | 0.135 GiB | 评测产物，可清理 |
| uv 下载缓存 | 3.952 GiB | 否，可清理 |
| 失败的 Anaconda 环境 | 2.128 GiB | 否，仅本次诊断保留 |
| hybrid VLM 模型 | 2.168 GiB | pipeline 不需要 |

安装文档应按官方更保守的磁盘建议预留空间；上表是本机实际文件大小，不把 uv 缓存和失败环境冒充运行时硬需求。

## 逐论文结果

| arXiv | 页数 | 耗时 | 展示候选 | 行内计数 | 状态 |
|---|---:|---:|---:|---:|---|
| 1706.03762 | 15 | 181.4 s | 5 | 108 | completed |
| 1412.6980 | 15 | 397.2 s | 34 | 500 | completed |
| 2006.11239 | 25 | 287.8 s | 26 | 330 | completed |
| 1312.6114 | 14 | 356.2 s | 31 | 362 | completed |
| 1512.03385 | 12 | 113.1 s | 2 | 52 | completed |
| 1502.03167 | 11 | 152.8 s | 16 | 214 | completed；漏 BN-4/5 |
| 1607.06450 | 14 | 317.6 s | 35 | 170 | completed |
| 1810.04805 | 16 | 134.7 s | 0 | 58 | completed；展示列表为空 |
| 2106.09685 | 26 | 345.5 s | 7 | 406 | completed |
| 1312.5602 | 9 | 101.0 s | 3 | 144 | completed |
| 1406.2661 | 9 | 176.0 s | 8 | 188 | completed |
| 1707.06347 | 12 | 158.0 s | 13 | 124 | completed |
| 1806.07366 | 18 | 330.9 s | 54 | 266 | completed；1 个文字误报 |
| **合计** | **196** | **3,052.4 s** | **234** | **2,922** | **0 失败** |

## Windows 失败点

1. 本机已有 `D:\Anacanda3\python.exe` 携带 VC Runtime 14.27 DLL，优先于系统 14.44，导致 `onnxruntime_pybind11_state` 初始化失败。降级 ONNX Runtime 仍失败；使用 uv 管理的干净 CPython 3.12 后解决，未修改全局 Anaconda 或系统 DLL。
2. `mineru-api.exe` 是启动器，Windows 上只终止父进程可能留下 Python API 子进程；临时 CLI 也报告强制停止后未退出。复跑脚本已用 `taskkill /T` 限定清理本次 API 进程树，并保留单篇 checkpoint。
3. `mineru[all]` 在本机安装出 `torch 2.8.0+cpu`。`hybrid-engine --effort high` 下载 2.168 GiB VLM 后失败于 `CUDA is not available`。虽然机器有 8 GiB RTX 4070，当前驱动/torch 组合不能直接使用本地 hybrid；本轮没有为此改全局 CUDA、驱动或安装非官方 wheel。
4. 首次 API 初始化可能接近两分钟，脚本启动门限已设为 240 秒；单篇默认上限为 1,800 秒。

## 对产品分层的含义

POC B 只验证了本地服务契约和质量门禁，没有修改现有产品源码。后续若获批薄集成，仍必须保持：

1. 可靠 arXiv TeX 源优先；
2. 无可靠 TeX 时调用用户本机 MinerU pipeline；
3. 本地服务不可用、超时或失败时回退 Phase C；
4. arXiv HTML/ar5iv、PDF 摘要解读和现有推导路径不变；
5. 展示/编号公式进入列表并附裁剪图，行内公式留在正文结构；
6. 安装、健康检查、进度、取消、超时和磁盘清理必须成为薄集成验收项。

POC C 不启动。下一步等待用户确认是否批准 MinerU pipeline 的薄集成计划；未经批准不写产品代码。

## 参考资料

- [MinerU Quick Start](https://opendatalab.github.io/MinerU/quick_start/)
- [MinerU CLI](https://opendatalab.github.io/MinerU/usage/cli_tools/)
- [MinerU 输出文件契约](https://opendatalab.github.io/MinerU/reference/output_files/)
- [MinerU 模型源配置](https://opendatalab.github.io/MinerU/usage/model_source/)
- [MinerU 3.4.4（PyPI）](https://pypi.org/project/mineru/3.4.4/)
- [uv 安装文档](https://docs.astral.sh/uv/getting-started/installation/)
