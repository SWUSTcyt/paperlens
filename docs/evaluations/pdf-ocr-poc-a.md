# PDF OCR POC A：语料与金标冻结报告

日期：2026-07-20

## 结论

POC A 已完成，可作为 MinerU/Paddle 的统一 PDF-only 基准：13 篇、196 页真实 PDF，冻结 65 个展示/编号公式块，全部经裁剪图人工核对且可由 KaTeX 渲染。此结论只表示评测基准可用，**不表示任何 OCR 引擎已达到 P1，也不授权产品接入**。

评测时 `texSourceShortcut=false`。作者 HTML/TeX 只用于离线制作与复核金标，绝不进入被测引擎输入；引擎只能读取 PDF。行内公式不进入推导列表，只记录观察计数。

## 冻结范围与门禁

| 项目 | 冻结值 |
|---|---:|
| 论文 / 页数 | 13 / 196 |
| 展示或编号公式金标 | 65 |
| 金标占位符 | 0 |
| 金标 KaTeX 可渲染 | 65 / 65 |
| 核心公式 | Attention (1)(2)、ResNet (1)(2) |
| TeX 源捷径 | 关闭 |
| 行内公式策略 | 正文保留、单独计数，不进 P1 列表 |

P1 维持原裁决门：检测召回 ≥92%、精确率 ≥85%、结构完整正确 ≥85%、裁剪完整 ≥95%、KaTeX 可渲染 ≥95%、核心公式全部通过、13 篇文档失败数为 0。缺少逐条人工审核时裁决保持 `pending`，不会用 KaTeX 可渲染冒充公式正确。

## 语料分布

| arXiv | 论文 | 金标块 | 作者 HTML 行内观察数 |
|---|---|---:|---:|
| 1706.03762 | Attention | 2 | 139 |
| 1412.6980 | Adam | 6 | 未知* |
| 2006.11239 | DDPM | 7 | 376 |
| 1312.6114 | VAE | 6 | 353 |
| 1512.03385 | ResNet | 2 | 134 |
| 1502.03167 | BatchNorm | 5 | 228 |
| 1607.06450 | LayerNorm | 6 | 196 |
| 1810.04805 | BERT | 0 | 111 |
| 2106.09685 | LoRA | 4 | 633 |
| 1312.5602 | DQN | 3 | 176 |
| 1406.2661 | GAN | 5 | 202 |
| 1707.06347 | PPO | 7 | 未知* |
| 1806.07366 | Neural ODE | 12 | 253 |

共观察到 2,801 个作者 HTML 行内 `<math>`；这是正文行内复杂度的诊断量，不是 OCR 金标。`*` Adam/PPO 的转换页未暴露可计数 MathML，0 会被误读为“没有行内公式”，因此冻结为未知；POC B/C 应报告引擎自身的行内计数，但不以它阻塞 P1。

## 金标质量证据

- 修正了 BatchNorm 中参考文献 `(1)` 假锚点，改为 5 个真实展示块，包括 mini-batch 归一化与反向传播公式组。
- 修正了 LayerNorm 的正文 `Eq. (3)` 假锚点，并人工冻结 (1)–(6) 的真实页码与公式框。
- 对 DDPM、GAN、Neural ODE 等跨行/跨栏公式扩大并人工核对裁剪框，避免“编号所在单行完整、公式主体被截断”的假通过。
- Adam、PPO 及作者自定义宏均人工转写/展开为通用 LaTeX；65 条金标没有 `__TRANSCRIBE__`，KaTeX 校验为 65/65。
- 使用 `pypdfium2 4.30.0` 在隔离环境重建出的 JSON 与仓库金标 SHA-256 完全一致：`731e4a95f8cd8064b20881bd6f5065090ad782abbb4ca473d4faeba9cecf6bb`。

## Windows 从零复跑

实测环境：Windows、Node `24.12.0`、pnpm `10.33.2`、Python `3.10.9`、uv `0.8.11`。Git Bash 可用于 Git；以下 PowerShell 命令只负责创建 Python 环境和运行评测，不执行作者 TeX。

```powershell
pnpm install

node tests/phaseD.ocr-poc.mjs prepare --artifacts=local-artifacts/pdf-ocr-poc
node tests/helpers/collectPdfOcrReferences.mjs local-artifacts/pdf-ocr-poc

uv venv local-artifacts/pdf-ocr-poc/.venv --python 3.10
uv pip install --link-mode=copy `
  --python local-artifacts/pdf-ocr-poc/.venv/Scripts/python.exe `
  pypdfium2==4.30.0 Pillow==10.4.0

local-artifacts/pdf-ocr-poc/.venv/Scripts/python.exe `
  tests/helpers/build_pdf_ocr_gold.py `
  --output local-artifacts/pdf-ocr-poc/gold-rebuilt.json

pnpm test:phase-d:ocr-poc
node --test tests/pdfOcrPoc.test.mjs
```

作者 HTML/源码下载命令只服务金标复核；MinerU/Paddle 的预测命令不得读取 `references/` 或 `source-archives/`。正式复跑时，仓库中的金标是裁决输入，无须重新下载作者源。

## 实测耗时与磁盘

| 项目 | 本机实测 | 说明 |
|---|---:|---|
| 隔离 Python 环境首次安装 | 4.76 s | 下载两个 wheel；首次误装 4.30.1，见失败点 |
| 改装稳定固定版本 | 2.78 s | `pypdfium2 4.30.0` + Pillow 10.4.0 |
| 13 篇作者参考收集 | 13.1 s | 仅金标制作；网络时间会波动 |
| 65 条金标重建与裁剪 | 10.69 s | 隔离 Python 环境 |
| 金标/KaTeX 校验 | 0.31 s | 不含 Node 依赖安装 |
| 已缓存 PDF 清单校验 | 0.254 s | 首次 27.57 MiB 下载耗时未在本轮捕获 |

| 本地项目 | 占用 |
|---|---:|
| 13 篇 PDF | 27.57 MiB |
| 作者源码归档（仅金标） | 23.20 MiB |
| 裁剪图 / contact sheet | 3.20 MiB |
| 人工预览图 | 5.34 MiB |
| POC A Python 环境 | 12.48 MiB |
| POC A 本地目录合计 | 71.84 MiB |
| OCR 模型 | 0（POC A 尚未安装 MinerU） |

这些文件均位于 `/local-artifacts/`，由 `.gitignore` 排除。仓库仅保留文本语料清单、人工金标、可复跑脚本、测试和本报告。

## 失败点与处理

1. `pypdfium2 4.30.1` 安装时显示已被撤回，原因是文本抽取回归；固定为 `4.30.0` 后隔离重建成功且哈希一致。
2. uv 在不同磁盘间无法 hardlink，会退回复制；命令显式使用 `--link-mode=copy` 消除歧义，只增加少量安装时间/空间。
3. Codex 沙箱首次读取用户 uv cache 被拒绝；在普通用户终端不构成产品依赖，授权后隔离安装成功。复跑脚本不依赖该全局缓存。
4. 自动编号锚点会命中参考文献或正文引用，多行/两栏公式会被单行框截断；因此自动结果只能作为标注起点，最终坐标和 LaTeX 使用人工覆盖并由裁剪图核对。
5. arXiv/ar5iv 转换质量不一致，Adam/PPO 无可靠 HTML 行内计数；该缺口标为未知，没有伪造为 0，也不会进入 OCR 引擎输入。

## POC A 裁决与下一步

POC A 基准冻结通过。下一步是 POC B：在新的本地 Python 环境安装 MinerU，记录模型与依赖磁盘、首次/热启动耗时、逐文档失败和统一预测 JSON，再对 65 条金标完成人工结构/裁剪审核。只有 MinerU 真正通过 P1，才申请“薄集成”批准；否则按既定决策门进入 Paddle 对比或停止交付选项。
