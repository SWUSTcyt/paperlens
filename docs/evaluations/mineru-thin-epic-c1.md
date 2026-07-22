# MinerU 薄集成 Epic C1 验收记录

日期：2026-07-23

结论：**通过。** 本轮只完成 Windows 从零安装、幂等重装与脱敏诊断；未实现 C2 的升级、修复、卸载，也未扩张浏览器发布矩阵。

## 交付物

- `services/mineru/scripts/install-windows.ps1`：PowerShell 5.1+ 安装入口，使用 uv 与隔离 Python 3.12；运行时按 generation 构建，候选通过 `init/check-config/doctor` 后原子切换。
- `paperlens-mineru doctor`：检查平台、Python、MinerU 3.4.4、配置、存储、模型缓存、端口与可选 health；输出不包含 token 和绝对路径。
- `services/mineru/examples/verify_windows_install.ps1`：启动已安装服务，验证 schema v1 health 与真实 TypeScript `MineruClient.testConnection()`，结束后确认端口释放。
- 安装、重装、诊断和关键路径示例已写入 `services/mineru/README.md`。

## P0 裁决

- **不碰全局环境：通过。** 安装器只调用 uv 创建隔离 Python 3.12 generation，不安装或修改全局 Anaconda/CUDA。
- **配置与 token 安全：通过。** 已有配置不覆盖；首次 token 只显示一次；重复安装不重显；doctor 的正常与异常输出均不含 token/绝对路径。
- **失败可回收：通过。** 候选安装失败会删除候选 generation，旧 `current.txt`、旧运行时和用户配置保持不变；无 PaperLens marker 的目录拒绝覆盖。
- **localhost 边界：通过。** 配置仍只接受 `127.0.0.1`；安装器未放宽 host 或环境变量白名单。

## P1 裁决

- 全新隔离运行时首次安装成功：51.7 秒，运行时约 2.27 GB；MinerU 固定为 3.4.4。
- 同一路径真实重装成功：45.75 秒与 48.18 秒；generation 发生切换，只保留一个版本目录，旧 token 未重显。
- doctor 实测任务数据 192 B、运行时约 2.27 GB、模型缓存约 6.46 GB；未输出对应绝对路径。
- 已安装服务达到 `/v1/health ready`，真实扩展 TypeScript client 连接成功；验收结束后 `127.0.0.1:17860` 监听数为 0。
- Windows PowerShell 5.1 UTF-8、重复 `Path/PATH`、保留前缀环境变量冲突和真实服务进程跟踪均已修复并复测。

## 自动验证

- Python 服务：53/53。
- MinerU client/provider：15/15。
- PowerShell 安装功能测试：首次安装、幂等重装、失败保留旧运行时、拒绝无标记目录全部通过。
- `pnpm compile`、`pnpm build`、`uv build services/mineru` 全部通过。
- wheel 与 sdist、干净运行时、模型缓存和验收日志均位于 `.gitignore` 覆盖的 `local-artifacts/`。

## P2/P3

- P2 脱敏诊断已实现，可区分平台/Python/MinerU/配置/存储/端口/health，并记录运行时、任务数据和模型缓存占用。
- P3 GUI、Docker 未实现，符合 C1 边界；系统服务、自动更新同样未启动。
