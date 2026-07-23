# MinerU 薄服务 Epic C3 验收记录

日期：2026-07-23  
分支：`agent/mineru-windows-autostart-update`  
基线：`2248a1e`

## 1. 结论

Epic C3 的实现与本地验收通过，可以进入提交前人工复核。实现只覆盖本地 MinerU
薄服务的当前用户登录自启动和固定稳定通道更新；没有创建 Windows SCM 服务、要求
管理员权限、迁移 `%LOCALAPPDATA%`/token，也没有更新 Chrome 扩展本体。

当前固定仓库没有匹配 `mineru-v*` 的稳定 Release，因此首个生产资产发布后仍需执行
一次真实 GitHub 下载与应用冒烟。该项不改变已冻结的实现或资产契约。

## 2. P0 验收

### C3.1 当前用户登录任务

- 固定任务名和描述签名，只接受当前用户 SID、`Interactive + Limited`、登录触发器、
  隐藏 PowerShell 动作、`IgnoreNew` 与无限执行时长。
- 同名但签名或配置不可信的任务拒绝修改；注册和移除幂等。
- 启动前读取可信服务状态；服务已运行时不重复启动、不停止现有任务。
- 安装/修复失败恢复旧维护脚本和任务配置；卸载先移除可信任务。

### C3.2 固定稳定通道

- 仓库固定为 `SWUSTcyt/paperlens`，只接受非草稿、非预发布的
  `mineru-v<SemVer>` 与精确版本化 ZIP/`.sha256` 资产。
- 初始 URL、最终下载域、声明/实际大小、SHA-256、ZIP 路径、链接/特殊文件、
  Windows 保留名、重复路径、包根、包名和版本均有拒绝测试。
- Scheduled/UpdateNow 在下载前和安装前两次检查服务状态；运行中确定性跳过。
- 候选安装复用 C2 generation 事务；失败不切换 `current.txt`，登录流程继续旧服务。
- 更新状态原子写入且不含 token、绝对用户路径；更新范围不包含扩展本体。

P0 结果：通过。

## 3. P1/P2 验收证据

| 项目 | 结果 |
|---|---|
| Python 完整测试 | 85/85 通过，包含显式启用的真实任务计划测试 |
| 更新核心覆盖率 | `updates.py` 326 条可执行语句，62 条未覆盖，80.98% |
| 真实任务闭环 | 注册两次、契约核验、`health ready`、重复运行保持同一 PID、停止和移除通过 |
| 真实固定通道检查 | 返回 `UPDATE_CURRENT`；当前无匹配稳定 Release |
| 候选更新 | 有效候选切换到新 generation；doctor 失败候选保持旧 generation |
| 发布资产 | 生成 `paperlens-mineru-windows-0.1.0.zip` 及匹配 SHA-256 |
| TypeScript | `pnpm compile` 通过 |
| 扩展构建 | `pnpm build` 通过 |
| Python 构建 | wheel 与 sdist 生成，`uv build services/mineru` 通过 |
| 清理 | 无 `PaperLens MinerU` 任务、17860 监听或服务状态文件 |

离线、无更新、资产缺失、哈希不匹配、恶意 ZIP、24 小时间隔、并发锁、
运行中跳过、安装失败回滚均有确定性测试。手动 `CheckOnly` 可在服务运行时执行；
`UpdateNow` 不会中断运行中的 job。

P1/P2 结果：本地工程验收通过；首个生产 Release 的 GitHub 端到端应用列为发布时
人工冒烟。

## 4. P3 与范围复核

冻结排除项保持未实现：开机前启动、Windows SCM、多用户共享、代码签名、差分更新、
测试/预发布通道和 Chrome 扩展本体更新。未发现顺手扩张到浏览器发布矩阵或其他功能。

审查结论：无 P0/P1 阻断项；可以提交当前分支，合并仍需用户确认。
