# MinerU 薄集成 Epic C2 与发布门验收记录

日期：2026-07-23

结论：**P0/P1 通过，可提交评审。** C2 已完成升级/修复、可信停服、默认保留数据卸载、双确认完整清理和卸载后重装；Edge 与 Chrome for Testing 的真实 MinerU 闭环及最终工程门禁通过。没有合并 `main`。

## 交付物

- `paperlens_mineru.lifecycle`：数据目录 marker、无敏感信息的服务状态、PID/创建时间/可执行文件/配置/命令行联合校验，以及递归进程树停止。
- `install-windows.ps1`：候选版本验证后安全停服、端口释放后再切换 generation；失败继续保留旧 `current.txt`。
- `uninstall-windows.ps1`：默认只删除运行时；完整清理要求 `-PurgeData` 和精确确认短语，并再次验证运行时/数据 marker。
- `verify_windows_lifecycle.ps1`：真实修复、保留卸载、重装恢复和完整清理示例。
- PaperLens 专用模型缓存默认落在数据根目录 `models/modelscope` 与 `models/huggingface`，与任务目录分离并服从卸载保留/清理语义。
- 浏览器测试支持 `--offline`，把公网来源波动与上传/`file://` 发布回归拆开。

## P0 裁决

- **无残留 worker/端口：通过。** Edge 和 Chrome 的真实 OCR 完成后，上游 MinerU worker 仍常驻；分别执行默认卸载与完整清理，服务进程树退出，17860 均可独占绑定。
- **默认卸载不删数据：通过。** 配置 SHA-256、原 token、任务文件和专用模型文件在默认卸载后保持，随后重装可直接恢复连接。
- **完整清理二次明确：通过。** 只有 switch 与区分大小写的确认短语同时存在才删除已标记数据根；错误短语保持运行时、配置、任务和模型不变。
- **升级失败可恢复：通过。** 破损候选不会切换 `current.txt` 或删除旧 generation；候选完成校验后才停旧服务，停服或端口验证失败同样不切换。
- **不误杀进程：通过。** 状态 PID 被复用、exe/config/cmdline 不匹配或状态损坏时返回稳定错误，不调用 terminate；状态文件不含 token。

## P1 裁决

- 假包实测从 0.0.0 升级到 0.0.1，同版本修复再次切换 generation；失败重装保留当前 0.0.1。
- 真实约 2.27 GB 运行时用 159.1 秒完成“修复 → 运行中保留卸载 → 重装 → 运行中完整清理”，配置 hash 全程不变，最终无 runtime/data/端口残留。
- Edge 与 Chrome for Testing 均通过 Attention 真实 MinerU：5 条展示公式、108 处行内公式、page+bbox、章节关联和鉴权 crop；上传、单栏 Adam、`file://`、Markdown 也通过。
- Edge 通过 arXiv `/abs`、`/html`、真 LaTeX DOM 回跳和 `/pdf`。后续两浏览器在线复测遇到 arXiv 错误页，因此以 `--offline` 独立复验两款浏览器的本地来源矩阵；不把外部错误页伪装成产品通过。
- 服务缺失、401、版本不兼容、队列/上传/非法响应、取消、超时与损坏结果均有确定性原基线回退；crop 失效只影响图片核对，不改变公式列表。

## 自动与真实验证

- Python：61/61。
- MinerU client/provider：15/15。
- PDF：46/46。
- POC：13/13；13 篇、65 条展示/编号公式，TeX 捷径关闭，P1 无回归。
- Windows lifecycle 相关：21/21；真实 lifecycle 示例通过。
- Edge Phase C 在线核心 4 项通过；Edge/Chrome for Testing offline Phase C 各 7 项通过。
- Edge/Chrome for Testing 真实 MinerU 浏览器闭环各 7 项通过。
- `pnpm compile` 与 `pnpm build` 通过；临时运行时、Chrome for Testing、日志和验收 token 均未进入 Git。

## P2/P3 与已知限制

- P2 用户级快捷入口由 `%LOCALAPPDATA%\PaperLens\MinerU\runtime\paperlens-mineru.cmd` 提供。
- 官方 Chrome 150 不再允许本回归方式命令行加载 unpacked 扩展；自动化使用官方 Chrome for Testing 151，正式 Chrome 的打包扩展安装保留为发布人工项。
- P3 系统后台服务与自动更新未实现；GUI 与 Docker 也不在本轮范围。
- 用户显式覆盖到数据根之外的共享 `MODELSCOPE_CACHE`/`HF_HOME` 不属于 PaperLens 所有，完整清理不会删除；默认专用缓存不受此限制。
