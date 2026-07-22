# Session 摘要：MinerU 薄集成 Epic C1

日期：2026-07-23

## 处理的 Issue

- 只实现 C1：Windows 从零安装、幂等重装与脱敏诊断。
- 新增版本化运行时安装器、`doctor` 命令和 health + 扩展 client 关键路径验收脚本。
- 完成真实隔离安装、重复安装、失败保留旧运行时、UTF-8 与端口清理验收。
- 未进入 C2 的升级/修复/卸载，也未扩张浏览器发布矩阵。

## 使用的 Skill

- `execute-implement`：按 C1 P0–P3 串行实施。
- `verify-test`：先冻结测试矩阵，再按单元、功能、示例、真实关键路径验证。
- `verify-review`：提交前按 P0/P1 与 L1/L2/L3 分层裁决。
- `observe-session`：记录 Issue 状态、验证证据和返工情况。
- `improve-retro`：将 PowerShell UTF-8、重复 PATH 和配置前缀冲突沉淀为规则。

## 关键错误与解法

1. **Windows venv 不可搬迁**：未采用 staging 目录改名；改用最终 generation 路径构建和 `current.txt` 原子切换。
2. **PowerShell 5.1 中文乱码**：脚本增加 UTF-8 BOM，控制台、`PYTHONUTF8` 和 cmd code page 统一为 UTF-8。
3. **受限 uv 全局目录不可写**：测试改用 `local-artifacts` 下已隔离的 uv cache/Python 目录；产品脚本不写死测试路径。
4. **`Path/PATH` 重复键**：两次失败后停止硬改，用最小实验确认 .NET 定点重建 PATH 可使 `Start-Process` 工作，再固化修复。
5. **内部变量撞安全前缀**：`PAPERLENS_MINERU_GENERATION` 改为 `PL_MINERU_GENERATION`，不放宽未知配置拒绝规则。
6. **跟踪了 cmd 包装进程**：验收脚本改为直接跟踪当前 generation 的 Python 服务进程，结束后轮询端口释放。

## 验证结果

- Python 服务：53/53；MinerU client/provider：15/15。
- 安装功能测试覆盖首次、重装、失败回退与无 marker 拒绝。
- 真实首次安装 51.7 秒；两次重装 45.75/48.18 秒；运行时约 2.27 GB，模型缓存约 6.46 GB。
- health ready、真实 TypeScript client、UTF-8 输出与端口释放通过。
- `pnpm compile`、`pnpm build`、wheel/sdist 构建通过。

## 返工与降质检查

- PATH 问题命中重复阈值后按 Skill 停止硬撞并先做隔离实验；没有继续盲改。
- 所有失败均转化为自动断言或可重复验收脚本；未降低 P0/P1，未用构建通过替代真实关键路径。
- 当前环境没有可靠 token 用量数据，因此不伪造数值。

## 下一步

C1 提交并推送当前分支后等待用户确认；不自动开始 C2，不合并 `main`。
