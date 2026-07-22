# PaperLens：MinerU pipeline 薄集成

状态：**Epic A、Epic B 已过门；下一步进入 Epic C 交付与运维。** POC B、服务端与扩展真实浏览器闭环均通过冻结 P1，POC C 不启动。完整计划见 `docs/plan-mineru-thin-integration.md`。

- Epic A（完成）：A1 schema/安全契约；A2 单任务服务与真实三篇/取消复测；A3 原子归一化、上下文、受控裁剪。Python 47/47，65 条金标 P1 通过，234 条候选/裁剪与 POC B 一致。
- Epic B（完成）：严格 localhost client、上传前 health/版本门禁、Phase C 事务回退、真实进度/取消 UI、展示公式/page+bbox/crop 与 OCR 推导隔离。Attention 真实 Edge 闭环通过：5 条展示公式、108 处行内统计及鉴权裁剪图。
- Epic C（下一步）：完善 Windows 从零安装/升级/卸载与故障排查，补取消/超时/TTL 后 crop 失效的发布级浏览器矩阵。Docker 非默认，arXiv TeX 仅预留 provider 衔接点。

P0：不破坏 HTML/ar5iv、PDF 解读或 Phase C；不伪造进度；PDF/模型/crop/token 不进 Git。P1：所有失败确定性回退，取消无残留，POC B 指标与核心样本不下降。Epic C 仍按相同门禁推进，不以文档或环境困难降低标准。
