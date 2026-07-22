# Session 摘要：PDF OCR POC B（MinerU）

- 状态：`POC complete / P1 pass / 等待薄集成批准`
- Skills：`execute-implement`、`verify-test`、`verify-review`、`observe-session`
- 范围：PDF-only；关闭 arXiv TeX 捷径；未修改产品运行路径

## 完成

- 在与 POC A 相同的 13 篇、196 页、65 条冻结金标上完成 MinerU 3.4.4 CPU pipeline 评测。
- 65 条金标命中 63 条：召回 96.9%，结构正确率 96.9%，裁剪完整率 96.9%。
- 全部 234 个列表候选完成人工核验：233 个有效展示公式，精确率 99.6%；KaTeX 可渲染率 99.1%。
- Attention softmax / FFN 与 ResNet 两条核心样本均完整；BERT 正常解析为 58 个行内公式、0 个展示公式，不再属于整篇失败。
- 13 篇均成功，合计处理 3,052.36 秒（50.87 分钟），平均 15.57 秒/页；因此 P1 通过，不触发 POC C（Paddle）。
- 记录了 Windows 从零安装、耗时、磁盘占用、失败点和可复跑命令；PDF、模型、裁剪图与运行产物均位于被忽略的 `local-artifacts/`。

## 错误与解决

- 系统 Anaconda Python 3.10 中旧版 VC DLL 抢先加载，导致 ONNX Runtime 导入失败；改用 `uv` 管理的 CPython 3.12.11 后解决，未改全局 Python。
- MinerU API 冷启动超过最初 120 秒上限；按实测将 POC runner 的默认启动上限调为 240 秒，并记录冷启动阶段。
- Windows 上结束父进程后可能残留推理子进程；runner 改为对已启动的局部 PID 使用 `taskkill /T`，复测后端口和子进程均释放。
- Hybrid/VLM 效果优先烟测在当前 CPU-only PyTorch 环境明确失败为 `CUDA is not available`；该路径不纳入本轮 P1 结果，也不作为默认依赖。
- 两条 BatchNorm 跨算法框/跨页公式未召回；Adam 两条超长数组被识别但 LaTeX 尾部截断。保留为薄集成后的已知边界，不通过降低金标或门禁掩盖。

## 验证

- `pnpm.cmd test:phase-d:ocr-poc`：13 项测试通过，65 条金标校验通过。
- `pnpm.cmd compile`：通过。
- `pnpm.cmd build`：通过。
- 敏感信息扫描：未发现 Key、Token 或 `.env` 内容。
- Git 忽略校验：原始 PDF、模型、裁剪图和运行输出均未进入待提交文件。
- 未执行 commit / push。

## 降质检测

- Review 轮次正常，无 P0/P1 标准滑坡。
- 安装环境和进程生命周期问题均通过可复跑脚本或文档收口，没有反复修改产品代码。
- POC 已达到决策门，下一步必须等待用户单独批准薄集成；不得自行扩大到产品接入。
