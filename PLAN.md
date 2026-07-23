# PaperLens：MinerU pipeline 薄集成

状态：**Epic A/B 已合入；Epic C 的 C1、C2 与发布门 P0/P1 已通过。** 完整标准与证据见 `docs/plan-mineru-thin-integration.md`。

- 已完成：本地服务、扩展接入、事务回退、真实进度/取消、crop 与 OCR 隔离；Python 61/61、65 条金标 P1，以及 Edge/Chrome for Testing 真实 MinerU 闭环通过。
- C1（完成）：Windows 隔离安装、幂等重装、失败保留旧运行时、脱敏 doctor；真实 health 与扩展连接通过。
- C2（完成）：候选升级/修复、可信进程树停止、默认保留数据卸载、双确认完整清理、卸载后重装恢复。
- 发布门（完成）：Edge/Chrome 上传与 `file://`、真实 5+108 MinerU 与鉴权 crop、失败回退单测、13 篇 65 条金标、compile/build 均通过。arXiv 在线链路已在 Edge 通过；后续复测时站点返回错误页，作为外部波动记录，不改变已通过证据。

P0：不碰全局 Anaconda/CUDA；不泄漏 token/覆盖配置；失败可回收；仅监听 `127.0.0.1`；只终止带可信状态的自有进程。P3 系统服务、自动更新、GUI 与 Docker 保持 follow-up，不进入本轮。
