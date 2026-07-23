# PaperLens：MinerU pipeline 薄集成

状态：**Epic A/B 与 Epic C（C1–C3、发布门）均已完成实现和本地验收。** 完整标准见 `docs/plan-mineru-thin-integration.md`。

- 已完成：本地服务、扩展接入、事务回退、真实进度/取消、crop 与 OCR 隔离；Python 61/61、65 条金标 P1，以及 Edge/Chrome for Testing 真实 MinerU 闭环通过。
- C1（完成）：Windows 隔离安装、幂等重装、失败保留旧运行时、脱敏 doctor；真实 health 与扩展连接通过。
- C2（完成）：候选升级/修复、可信进程树停止、默认保留数据卸载、双确认完整清理、卸载后重装恢复。
- C3.1（完成）：当前用户有限权限的任务计划登录自启动；幂等注册/状态/移除，服务运行时不重复启动。
- C3.2（完成）：固定 GitHub Releases 稳定通道；登录前最多 24 小时检查一次，版本化 ZIP+SHA-256，安全解包并复用候选安装/回滚；提供手动检查/立即更新。

验收：Python 85/85、更新核心覆盖率 80.98%、真实任务登录契约/health/重复启动/清理通过，`pnpm compile`、`pnpm build`、`uv build` 通过。首个 `mineru-v*` 远端资产发布后仍需做一次生产通道冒烟；当前仓库没有匹配 Release。
