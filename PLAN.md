# PaperLens：MinerU pipeline 薄集成

状态：**Epic A/B 已合入；Epic C Issue C1 已过门，C2 未启动。** 完整标准与证据见 `docs/plan-mineru-thin-integration.md`。

- 已完成：本地服务、扩展接入、事务回退、真实进度/取消、crop 与 OCR 隔离；Python 47/47、65 条金标 P1 和 Edge 闭环通过。
- C1（完成）：Windows 隔离安装、幂等重装、失败保留旧运行时、脱敏 doctor；真实 health 与扩展连接通过。
- 下一步 C2（未启动）：升级、修复和两种卸载；过门后再细化浏览器发布矩阵。

P0：不碰全局 Anaconda/CUDA；不泄漏 token/覆盖配置；失败可回收；仅监听 `127.0.0.1`。P1：单一路径可重复安装，并记录耗时、磁盘与诊断证据。Docker、GUI、系统服务和自动更新不进入 C1。
