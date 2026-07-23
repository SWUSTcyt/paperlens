# MinerU pipeline 薄集成实施计划

> 状态：**Epic A（A1–A3）、Epic B（B1–B4）与 Epic C（C1–C3、发布门 P0/P1）已过门。**
> 依据：`docs/evaluations/pdf-ocr-poc-b-mineru.md` 的 P1 通过结果。
> 目标：在不改变现有网页抽取和 PDF 解读能力的前提下，为任意 PDF 增加可取消、可回退、可人工核对的本地展示公式识别。
> Epic B 验收证据：`docs/evaluations/mineru-thin-epic-b.md`。
> Epic C1 验收证据：`docs/evaluations/mineru-thin-epic-c1.md`。
> Epic C3 验收证据：`docs/evaluations/mineru-thin-epic-c3.md`。

## 1. 冻结边界

### 本轮包含

1. 只接本机 `127.0.0.1` 上的 MinerU 3.4.4 `pipeline` 服务；默认安装为 Python + uv，Docker 不是默认路径。
2. 当前标签在线 PDF、`file://` PDF和上传/拖拽 PDF 均可复用同一服务。
3. 列表只收展示公式和编号公式；行内公式仅保留在正文结构并显示统计数，不批量进入推导列表。
4. 每条 MinerU 公式携带 `page + bbox`，按需获取裁剪图供用户核对；裁剪图不可用时仍显示页码、框坐标和 LaTeX。
5. 支持真实阶段状态、取消和超时。只有实际可观测的字节数、pdf.js 已完成页数才能显示百分比；MinerU 内部解析若无可信页级事件，显示不定进度阶段和耗时。
6. MinerU 缺失、未就绪、拒绝、协议不兼容、超时、取消或结果校验失败时，确定性保留 Phase C 结果。

### 本轮不包含

- 不接远程 MinerU、Mathpix、Paddle、其他云 OCR 或任意可配置 HTTP 主机。
- 不实现 arXiv TeX 源获取/解析；只预留 provider 路由和数据来源字段。
- 不把行内公式全部放入推导列表，不承诺扫描件、手写公式或所有复杂多行结构均可识别。
- 不把 PDF、模型、裁剪图、服务 token 或临时输出提交到 Git，也不把图片写入 `chrome.storage.session`。
- 不修改 HTML/ar5iv 的 DOM 真 LaTeX 抽取、回跳和推导行为。

## 2. 总体数据流

```text
HTML / ar5iv ───────────────→ 现有真 LaTeX 路径（零改路由）

在线 / file / 上传 PDF 字节
          │
          ├─→ pdf.js + Phase C ─→ PaperContent 基线 ─→ 解读立即可用
          │                              │
          │                              └─ MinerU 失败/取消/超时：原样保留
          │
          └─→ 127.0.0.1 MinerU job ─→ 校验完整结果 ─→ 原子替换公式字段
                                              │
                                              ├─ 展示/编号公式 → 推导列表
                                              ├─ page+bbox → 按需裁剪图
                                              └─ 行内公式 → 仅统计/正文信息
```

关键原则是**基线先成、增强后到、事务替换**：`extractPdf` 先产出完整的正文、章节和 Phase C 公式候选；MinerU 作为公式增强任务独立运行。任何失败都不得清空正文、章节、摘要或已有 Phase C 公式。

未来接入 arXiv TeX 时，PDF 公式 provider 的顺序扩展为：

```text
可靠 arXiv TeX（未来） → 本地 MinerU → Phase C
```

HTML/ar5iv 不进入该 provider 链，继续使用现有 DOM 真 LaTeX。

## 3. 本地服务边界

### 3.1 安装与启动

- 新增独立的 `services/mineru/` Python 包，固定兼容 `mineru==3.4.4`，提供 `paperlens-mineru serve` 命令。
- 文档默认流程：安装 uv → `uv tool install` 或项目隔离 venv → 启动服务。不得要求用户安装或修改全局 Anaconda、CUDA 或系统 DLL。
- 默认监听 `127.0.0.1:17860`，拒绝绑定 `0.0.0.0`；扩展仅允许配置端口，不接受主机名或完整 URL。
- 扩展 manifest 只新增精确的 `http://127.0.0.1/*` host permission；client 固定构造该地址，不复用任意在线 PDF 的可选权限来接受远端 OCR 地址，也不使用含义可能漂移的 `localhost`。
- 首次启动输出随机访问 token。token 由用户填入 PaperLens 设置并存入 `chrome.storage.local`；日志、错误和诊断导出不得回显 token。
- Docker 最多作为后续可选文档，不是安装、测试或产品成功路径的前置条件。

### 3.2 最小 HTTP 协议（schema v1）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/health` | 返回 schema、MinerU/pipeline 版本、`starting/ready/degraded` 和能力，不触发任务 |
| `POST` | `/v1/jobs` | 上传并验签一个 PDF，返回不透明 `jobId` |
| `GET` | `/v1/jobs/{jobId}` | 返回真实任务阶段、起止时间、警告或完整结果 |
| `POST` | `/v1/jobs/{jobId}/cancel` | 幂等取消；终态重复调用仍成功 |
| `GET` | `/v1/jobs/{jobId}/crops/{cropId}` | 按需返回一张裁剪图 |
| `DELETE` | `/v1/jobs/{jobId}` | 删除该任务临时产物；终态自动 TTL 清理仍保留 |

除最小健康信息外均要求 bearer token。服务只接受 `%PDF-` 签名、限定大小和页数的单文件请求；单并发、有限队列；响应不暴露本地绝对路径。服务校验 `Host`，CORS 不向普通网页开放。

结果使用严格 schema：展示公式包含 `id`、`latex`、`page`、归一化 `bbox=[x0,y0,x1,y1]`（0–1000）、可选 `cropId`、可选 `sectionPath/context`；文档级包含 `inlineFormulaCount`、engine/version 和 warnings。MinerU 未提供可靠置信度时不伪造 `confidence`。

### 3.3 真实进度、取消和超时

任务状态只允许以下单向转换：

```text
accepted → queued → preparing → loading-model → parsing
         → normalizing → crops-ready → completed
任意非终态 → cancelling → cancelled
任意非终态 → failed | timed-out
```

- `preparing`、`loading-model`、`normalizing` 和 `crops-ready` 必须由对应代码边界发出；不能按时间推算。
- `parsing` 若 MinerU 3.4.4 没有稳定页级回调，只显示“不定进度 + 已耗时”，不得显示 `N/总页数` 或估算百分比。
- 浏览器下载和 pdf.js 基线阶段沿用真实字节/已完成页进度；上传只有在浏览器 API 提供实际 transferred/total 时才显示百分比，否则同样不定进度。
- Python 父服务保持响应，MinerU 运行在受监管 worker 进程中。取消或硬超时必须终止该 job 的 worker 进程树、删除输入 PDF和未完成产物；Windows 复测不得遗留端口或子进程。
- 客户端默认：健康检查 3 秒、上传 60 秒、任务 30 分钟；任务上限可在合理范围内配置。任一超时都触发服务端取消并进入 Phase C 回退。

### 3.4 本地文件生命周期

- 输入 PDF只存任务临时目录，任务终态立即删除。
- 裁剪图和结构化结果放在 `%LOCALAPPDATA%/PaperLens/MinerU/jobs/<jobId>`，默认 24 小时 TTL；用户可立即清理。
- 模型缓存与任务缓存分目录展示磁盘占用；“清理任务”不能误删模型。
- 扩展缓存只保存公式文本、页码、bbox、job/crop 引用和状态，不保存 PDF 或图片字节。服务重启/TTL 后裁剪图失效时，UI 可读降级。

## 4. 扩展内契约

### 4.1 数据模型

最小扩展现有类型：

- `FormulaSupport` 增加 `ocr`，不能把 MinerU 结果标成真 LaTeX，也不能继续当作 Phase C 原始文本。
- `Formula` 增加可选 `recognitionSource`、归一化 `bbox` 和 `cropRef`；MinerU 公式 `display=true`。
- `PaperContent` 增加可选的公式识别摘要：provider、engine version、inline count、warnings、fallback reason；字段保持可选以兼容旧缓存和网页来源。
- `cropRef` 只能是本地 job/crop 标识，不得是文件路径、base64 或任意 URL。

OCR 结果先完整校验，再一次性替换 `formulas`、`sections[].formulaIds` 和识别摘要；不能边收边混入半份公式。章节关联优先使用 MinerU 输出顺序中的标题/邻近文本，无法可靠匹配时归入“第 N 页 / 其他公式”，不得猜测章节。

### 4.2 路由与回退

新增纯编排层 `pdfFormulaProvider`，输入 PDF 字节、Phase C 基线、AbortSignal 和进度回调，输出以下可判别结果之一：

- `enhanced`：通过 schema 与完整性校验的 MinerU 结果；
- `fallback`：保留基线并携带枚举原因；
- `cancelled`：用户取消增强，保留已经完成的基线；
- `disabled`：用户未启用本地服务，直接使用 Phase C。

回退原因至少覆盖：服务未配置、连接失败、未就绪、认证失败、版本不兼容、上传失败、任务失败、取消、超时、结果 schema/bbox/页码非法、空结果。空结果只有在服务明确报告“成功且展示公式为 0”时才是有效结果；协议异常不能把 Phase C 误替换为空。

网页抽取不会调用此编排层。arXiv TeX 后续只需在同一 provider 接口前增加一个实现；本轮不增加网络取源逻辑。

### 4.3 UI 行为

- Options 增加“本地 MinerU”开关、端口、token、测试连接、版本/就绪状态和安装文档入口。
- PDF 基线完成后，论文解读立即可用；公式 Tab 显示独立增强任务状态与取消按钮。
- 进度文案显示真实阶段，例如“正在载入模型”“MinerU 正在解析（已用时 02:13，暂无可靠页级进度）”“正在生成裁剪图”。
- 成功后公式卡显示“MinerU 本地识别”、页码、bbox 和裁剪图展开项；裁剪图懒加载、失败可重试且不阻塞推导。
- 行内公式只显示“正文中识别到 N 处行内公式”，不生成 N 个列表项。
- OCR 推导使用独立提示：把 MinerU LaTeX 视为可核对的 OCR 结果，不声称是真源码；UI 始终提示先对照裁剪图。
- 明示已知上限：POC B 中 BatchNorm 的 BN-4 算法框多行块与 BN-5 跨页梯度块漏检，Adam 附录两条超长 `array` 尾部截断；扫描件与非标准排版效果也不稳定。
- 失败/取消后显示具体回退原因和“当前使用 Phase C 实验性结果”，不把 fallback 包装成 MinerU 成功。

## 5. 实施拆分

### Epic A：本地服务与稳定协议

#### Milestone A1：可独立验收的 MinerU 服务

**Issue A1 — 冻结 schema 与安全配置**

- 输入：POC B adapter、65 条金标、上述 HTTP 契约。
- 输出：Python/TypeScript 共用 JSON schema fixtures、错误码表、配置说明。
- 依赖：无。
- P0：只允许 `127.0.0.1`；token、PDF、路径不进入日志/响应/Git；越界 bbox、页码和路径必须拒绝。
- P1：正常、0 展示公式、版本不兼容、非法结果、认证失败均有确定性契约测试。
- P2：schema 向后兼容策略与诊断导出格式。
- P3：OpenAPI 页面美化。

**Issue A2 — 单任务 worker、状态机与清理**

- 输入：A1 schema、固定 MinerU 3.4.4 pipeline 环境。
- 输出：健康检查、创建/查询/取消/删除 job；受监管 worker；TTL 清理。
- 依赖：A1。
- P0：取消/超时真正停止任务进程树并删除输入；服务崩溃不残留本轮 worker；不可伪造页级进度。
- P1：Windows 干净环境完成 Attention、ResNet、BERT；冷启动、运行、失败、取消均呈现真实阶段；单并发队列可控。
- P2：任务/模型磁盘占用查询与手动清理。
- P3：多任务并发。

**Issue A3 — 结果归一化、上下文与裁剪端点**

- 输入：MinerU `content_list/middle` 输出。
- 输出：展示公式 schema、行内计数、章节/上下文、归一化 bbox、惰性裁剪图。
- 依赖：A2。
- P0：不得返回绝对路径或目录穿越；损坏/缺页结果整体失败，不交付半份数据。
- P1：同一 65 条金标仍达到 POC B P1，且核心 4/4、13 篇失败 0；233/234 候选审核结论无回归。
- P2：裁剪图尺寸/格式上限与缓存命中统计。
- P3：可选高清裁剪。

> **A1–A3 门禁：服务未通过取消、清理、安全和 65 条回归前，不开始产品路由。**

### Epic B：扩展内薄接入

#### Milestone B1：编排与确定性回退

**Issue B1 — 类型、设置与本地 client**

- 输入：A1 schema。
- 输出：`ocr` 来源类型、设置项、严格 client、健康检查和 AbortSignal 支持。
- 依赖：A1。
- P0：client 只能请求 `http://127.0.0.1:<合法端口>`；token 不出现在错误、遥测或导出；旧缓存可读取。
- P1：超时、401、连接拒绝、版本错误、非法 JSON/schema 均映射为稳定错误码。
- P2：连接诊断复制功能（自动脱敏）。
- P3：端口自动发现。

**Issue B2 — PDF provider 编排与事务合并**

- 输入：Phase C `PaperContent` 基线、B1 client。
- 输出：MinerU 增强结果或原样 Phase C 回退；章节 ID 重建；独立任务状态。
- 依赖：A3、B1。
- P0：HTML/ar5iv 不调用 MinerU；任何服务失败不改变正文/摘要/章节；取消/切 tab 后旧任务不能覆盖新页面。
- P1：在线 PDF、上传 PDF、`file://` PDF 都可增强；成功结果一次性生效；所有枚举失败路径确定性回退。
- P2：同一 PDF 会话内结果复用；裁剪引用失效可降级。
- P3：跨浏览器重启恢复 job。

**Issue B3 — 真实进度与取消 UI**

- 输入：B2 状态、现有 PDF 进度 UI。
- 输出：基线/增强分阶段状态、耗时、取消和超时反馈。
- 依赖：B2。
- P0：不显示推算的 MinerU 页百分比；取消后不得继续写状态或替换公式；回退原因真实可见。
- P1：下载、pdf.js、上传、排队、模型加载、解析、归一化、裁剪、完成均按实际事件展示；无页级事件时明确不定进度。
- P2：最近一次阶段耗时诊断。
- P3：系统通知。

**Issue B4 — 公式列表、裁剪核对与 OCR 推导隔离**

- 输入：B2 公式和 cropRef。
- 输出：展示/编号公式列表、懒加载裁剪图、行内统计、OCR 专用提示和推导路径。
- 依赖：B2。
- P0：不把 OCR 标成真 LaTeX；不把行内公式批量塞入列表；裁剪失败不阻断列表/推导；网页真 LaTeX UI/prompt 零回归。
- P1：每条 MinerU 候选可看到 page+bbox，存在 crop 时可核对；Attention/ResNet 核心卡片正确；BERT 显示 0 展示、58 行内而非失败。
- P2：裁剪图缩放与键盘可访问性。
- P3：在 PDF 阅读器中自动定位 bbox（本轮不做）。

### Epic C：交付与运维

#### Milestone C1：Windows 可重复安装生命周期

起始条件：Epic A/B 已通过 PR #1 合入 `main`；以干净 Windows、Python 3.12 与 uv 为默认环境，不依赖全局 Anaconda、CUDA 或 Docker。

**Issue C1 — 从零安装与脱敏诊断（完成）**

- 输入：现有源码版安装步骤、`paperlens-mineru init/check-config/serve`、冻结的 MinerU 3.4.4 依赖。
- 输出：可重复执行的 Windows 安装入口、安装前置检查/脱敏诊断、从零安装与扩展连接验收记录。
- 依赖：Epic A/B。
- P0：不得修改全局 Anaconda/CUDA；不得覆盖已有配置或泄漏 token；失败安装可回收且不删除用户数据；服务仍只允许 `127.0.0.1`。
- P1：干净 Windows 按单一路径可完成安装、`init`、配置校验、启动、`/v1/health ready` 与扩展“测试连接”；重复执行结果幂等；记录安装耗时与服务/模型磁盘占用。
- P2：诊断输出自动脱敏，并能区分 Python/uv、依赖、配置、端口和模型就绪问题。
- P3：GUI 安装器和 Docker。

**Issue C2 — 升级、修复与卸载（完成）**

- 输入：C1 安装入口和现有配置/任务/模型目录约定。
- 输出：同版本修复、升级、保留数据卸载、显式完全清理流程及故障排查文档。
- 依赖：C1。
- P0：停止/卸载后不残留服务 worker 或占用端口；默认卸载不得误删配置、模型和任务数据；完全清理必须二次明确；升级失败时旧服务可恢复或扩展确定性回退 Phase C。
- P1：实测修复安装、版本升级模拟、保留 token/config 卸载和完全清理；重装后扩展连接恢复；每条路径有可读错误与恢复步骤。
- P2：可选的用户级快捷启动方式。
- P3：系统级后台服务和自动更新。

实现与验收（2026-07-23）：

- 安装器继续使用候选 generation；候选完成配置、doctor、停服和端口验证后才切换。失败候选不修改 `current.txt`，版本升级模拟与同版本修复均通过。
- 服务在已标记数据根目录写入不含 token 的状态文件；只有 PID、创建时间、可执行文件、配置路径和命令行全部匹配时才允许递归停止进程树，PID 复用或伪造状态一律拒绝。
- 默认卸载只删除已标记运行时，配置、任务与 PaperLens 专用模型缓存全部保留；完整清理必须同时提供 `-PurgeData` 和精确短语 `DELETE PAPERLENS MINERU DATA`，且数据目录 marker 有效。
- 真实 2.27 GB 运行时在 159.1 秒内完成“修复 → 运行中保留卸载 → 重装恢复 → 运行中完整清理”，每次结束均验证 17860 可独占绑定。
- P2 由稳定的用户目录启动器 `paperlens-mineru.cmd` 提供；P3 系统服务和自动更新按计划延后。

#### Milestone C3：Windows 用户级后台启动与稳定更新（完成）

起始条件：C1/C2 与发布门已通过并合入 `main`；继续使用 `%LOCALAPPDATA%` 的用户级运行时、配置和 token。详细边界见 `docs/spec/mineru-windows-user-autostart-update.md`。

**Issue C3.1 — 当前用户登录自启动与任务生命周期（完成）**

- 输入：C1/C2 安装器、稳定启动器、可信服务状态与保留数据卸载流程。
- 输出：任务计划程序的幂等注册、状态、立即运行和移除入口；安装/修复/卸载联动；使用示例。
- 依赖：C2。
- P0：只以当前用户有限权限运行，不创建 SCM 服务、不要求管理员权限、不改变现有配置/token；任务操作只能命中固定 PaperLens 任务，卸载前必须移除任务；服务已运行时不得重复启动或终止任务。
- P1：真实注册后可核验登录触发器、隐藏 PowerShell 动作、稳定维护脚本路径和无限执行时长；重复注册结果幂等；立即运行可到达 `/v1/health ready`；移除后无任务、worker 或端口残留。
- P2：状态和错误输出脱敏、可读，可区分未安装、任务缺失、任务配置漂移和服务已运行。
- P3：开机前启动、SCM、多用户共享服务。

**Issue C3.2 — 固定稳定通道自动更新（完成）**

- 输入：C3.1 登录维护入口、C2 候选 generation 安装与回滚、固定 `SWUSTcyt/paperlens` GitHub Releases。
- 输出：登录前置的 24 小时限频检查、版本化 ZIP+SHA-256 下载与安全解包、手动检查/立即更新命令、Release 资产契约和示例。
- 依赖：C3.1。
- P0：仅接受固定仓库的非预发布稳定 Release；哈希、大小、ZIP 路径或包结构任一校验失败均不得调用安装器；服务已运行时跳过且不中断任务；失败不得切换 `current.txt`、覆盖配置、泄漏 token 或更新 Chrome 扩展。
- P1：无更新、成功更新、离线、Release/资产缺失、哈希不匹配、恶意 ZIP、候选安装失败和 24 小时间隔均有确定性测试；成功路径复用 C2 安装器并真实验证新 health，失败路径旧 health 仍可用。
- P2：原子保存不含 token/绝对用户路径的检查状态与结果码；下载有超时、大小上限和临时文件清理。
- P3：代码签名、差分更新、测试/预发布通道和扩展本体更新。

实现与验收（2026-07-23）：

- 安装器默认幂等注册固定的 `PaperLens MinerU` 当前用户登录任务；任务使用 `Interactive + Limited`、隐藏 PowerShell 动作、`IgnoreNew` 和无限执行时长。真实任务完成“注册两次 → 运行 → health ready → 再次运行保持同一 PID → 停止 → 移除”，最终无任务、worker、状态文件或 17860 监听。
- 登录维护在服务启动前检查固定 `SWUSTcyt/paperlens` 稳定 Release，24 小时内不重复联网；服务已运行时更新动作立即跳过，检查、下载或安装失败时继续启动旧 generation，不中断现有任务。
- 更新只接受 `mineru-v<SemVer>`、精确版本化 ZIP 与 `.sha256`。下载大小、最终 GitHub 域、SHA-256、安全 ZIP 根、Windows 路径/设备名、包名和版本均通过后，才调用 C2 候选安装器；失败候选不切换 `current.txt`。
- Python 85/85（含真实任务测试）通过；`updates.py` 语句覆盖率 80.98%；`pnpm compile`、`pnpm build`、`uv build services/mineru` 通过。固定通道真实检查返回 `UPDATE_CURRENT`，状态文件不含 token 或绝对路径。
- 首个稳定通道 `mineru-v0.1.0` 已发布，包含精确版本化 ZIP 与 SHA-256 资产。2026-07-24 本机首次安装、`health=ready` 与固定通道 `CheckOnly=UPDATE_CURRENT` 的 A 冒烟通过；同版本不会重复下载，真正下载/应用保留到后续更高版本。本地已分别验证 Release 打包/哈希、网络与恶意包契约、候选切换/失败回滚及真实服务 health，不降低发布资产契约。

#### Milestone C2：发布矩阵与最终门禁（完成）

- 真实 Edge/Chrome 回归：在线、上传、file、服务缺失、401、版本不兼容、取消、超时、切页竞态、TTL 后 crop 失效。
- 薄集成发布门：P0/P1 全过、`pnpm compile`、`pnpm build`、65 条金标无回归、无敏感/本地产物入 Git。
- 不默认编写 Docker 路径；若后续需要，作为独立 P2 Issue 申请。

发布证据（2026-07-23）：

- Edge 与 Chrome for Testing 均通过上传 PDF、`file://`、单栏 PDF、Markdown、Phase C 公式标识和推导链；Edge 另通过 arXiv `/abs`、`/html` 与 `/pdf` 在线回归。
- Edge 与 Chrome for Testing 均用真实 MinerU 完成 Attention 原子增强：5 条展示公式、108 处行内公式、page+bbox、受控 crop 鉴权读取；随后在上游 worker 常驻时分别完成默认卸载与完整清理，端口均释放。
- 服务缺失、401、版本不兼容、取消、超时、非法/TTL 后 crop，以及切页旧任务保护由 client/provider 单测和 `App.tsx` runId+URL 双门禁覆盖；失败不修改 Phase C 基线。
- Python 61/61、MinerU client/provider 15/15、PDF 46/46、POC 13/13、`pnpm compile` 与 `pnpm build` 通过；13 篇 65 条金标和 P1 指标无回归。
- 官方 Chrome 150 阻止命令行加载 unpacked 扩展，自动化改用 Google 官方 Chrome for Testing 151；后续在线复测遇到 arXiv 错误页，保留 Edge 已通过的在线证据并单独运行两款浏览器的离线来源矩阵。

## 6. 验收矩阵与发布门

| 维度 | 必须通过 |
|---|---|
| 质量 | 冻结 65 条 P1 指标不低于 POC B；Attention/ResNet 4/4；13 篇文档失败 0 |
| 来源 | 在线任意 PDF、上传、file 成功；HTML/ar5iv 全回归 |
| 回退 | 服务关闭、冷启动失败、401、版本不兼容、超时、取消、worker 崩溃、非法结果均保留 Phase C |
| 进度 | 事件与真实边界一致；无 MinerU 假页数/假百分比；切页后无陈旧写回 |
| 隐私安全 | 仅 127.0.0.1；token 脱敏；PDF 终态删除；crop TTL；无路径穿越/超限输入 |
| UX | PDF 解读先可用；公式列表以展示公式为主；page+bbox/crop 可核对；已知上限可见 |
| 工程 | 单元、协议、功能、浏览器测试通过；compile/build 通过；无 PDF/模型/裁剪/Key 入 Git |

任一 P0/P1 失败都停止发布；拆 follow-up 或回退该 Issue，不降低标准。薄集成应置于设置开关之后，首版不替换未启用用户的 Phase C 默认行为。若出现不可恢复问题，关闭 provider 开关即可完全退回现有 PDF 管线，无需改动 HTML/ar5iv。

## 7. 需在实施批准时一并冻结的默认值

除非用户在批准实现时调整，建议冻结：

- 服务：`127.0.0.1:17860`、MinerU 3.4.4 pipeline、单并发。
- 输入限制：单 PDF 200 MiB、500 页；超过即不上传并保留 Phase C。
- 超时：健康检查 3 秒、上传 60 秒、单任务 30 分钟。
- 产物：输入终态删除；result/crop 24 小时 TTL；图片按需获取。
- 开关：本地 MinerU 默认关闭，用户完成安装和连接测试后主动开启。

这些值属于实现验收的一部分；后续只能通过显式计划变更调整，不能在开发中为“先跑通”而静默放宽。
