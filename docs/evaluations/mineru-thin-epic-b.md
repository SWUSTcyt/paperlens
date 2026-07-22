# MinerU 薄集成 Epic B 验收报告

日期：2026-07-22
范围：`docs/plan-mineru-thin-integration.md` 的 B1–B4；扩展 client、provider、UI、crop 与 OCR 推导隔离。

## 结论

Epic B 的 P0/P1 门禁通过，可以进入 Epic C 交付与运维。扩展默认仍关闭 MinerU；未启用、服务异常或结果非法时保留 Phase C 基线。HTML/ar5iv、网页真 LaTeX、PDF 解读与导出没有回退。

## B1：设置、严格 client 与健康门禁

- Options 提供端口、token、测试连接与显式启用；配置变化会先关闭开关，只有 health + bearer 探针成功后才能启用。
- base URL 只能由 `127.0.0.1` 和 1024–65535 端口构造；token、路径与内部异常不进入用户错误。
- 上传前必须通过 schema v1、MinerU 3.4.4 pipeline 与 `ready` 门禁；401、连接失败、版本不兼容、非法 JSON/schema 映射为稳定错误。
- 浏览器原生 `fetch` 显式绑定 `globalThis`，避免以实例方法调用时的 `Illegal invocation`；已有 Node 回归测试。

## B2：provider 编排与事务合并

- 在线 PDF、`file://` 与上传 PDF 都先完成 pdf.js/Phase C baseline，再异步启动 MinerU。
- 完整成功后一次性替换 `formulas`、章节 `formulaIds` 与 `formulaRecognition`；逐公式只保存 `jobId/cropId`，不保存路径、URL 或图片字节。
- 禁用、非 PDF、连接、认证、版本、队列、上传、任务失败、取消、超时、页数/bbox/schema 错误均原样返回 baseline；0 展示公式是合法增强结果。
- 切页/重新解析通过 run id + AbortController 防止旧任务覆盖新页面。

## B3/B4：真实状态、核对 UI 与推导隔离

- UI 只显示服务真实阶段与耗时；MinerU 3.4.4 没有可靠页级事件时不显示页数或估算百分比。用户可取消，回退原因可见。
- 公式列表标明“MinerU 本地识别（OCR）”、page+bbox、行内计数和已知上限；crop 按需鉴权读取，失败不阻断列表或推导。
- OCR 使用独立 prompt，要求先复述收到的 OCR LaTeX、显式标注建议，不得按论文记忆静默补齐；Markdown 同样声明不是作者源码。
- 网页真 LaTeX 仍保留原 prompt、DOM 回跳和数学块导出。

## 真实浏览器证据

`pnpm test:mineru:browser` 在 Edge + 本地 MinerU 3.4.4 上通过：

- 上传 Attention PDF 并切换合成来源；8 位作者识别通过。
- 原子增强得到 5 条展示公式与 108 处行内统计。
- 5/5 公式均有 `mineru-ocr`、page、bbox、cropRef、sectionPath，且 ID 写入章节树。
- 鉴权 crop 成功显示为内存 blob URL。
- Adam 单栏、`file://` PDF 与 Markdown 导出继续通过。

`pnpm test:phase-c:browser` 独立通过 arXiv `/abs`、`/html`、`/pdf`、网页真 LaTeX 回跳、上传/file、Phase C 页码 UI 与流式 prompt 链。

## 发布门证据

| 检查 | 结果 |
|---|---:|
| Python 服务测试 | 47/47 |
| MinerU client/provider | 15/15 |
| PDF 单元/功能测试 | 46/46 |
| OCR POC 测试 | 13/13 |
| 65 条金标 | P1 pass |
| 金标指标 | 召回 96.9%，精确率 99.6%，结构 96.9%，裁剪 96.9%，KaTeX 99.1% |
| 核心公式 / 文档失败 | 4/4 / 0 |
| TypeScript / 生产构建 | `pnpm compile`、`pnpm build` 通过 |
| 真实 MinerU / Phase C 浏览器 | 通过 / 通过 |

本轮未执行交互式“任意在线 PDF 权限弹窗”测试；同一权限路径此前已有独立测试与浏览器覆盖，本轮 Phase C 浏览器结果明确标记该项为 skip。Epic C 仍需补齐 Windows 从零安装、升级/卸载、取消/超时与 TTL 后 crop 失效的发布级矩阵。

## 本轮发现并固化的问题

- 浏览器 E2E 曾复用陈旧 `.output`；所有浏览器脚本现先自动 `pnpm build`。
- 原生 fetch 接收者错误只在浏览器暴露；现已绑定并补回归。
- E2E 曾要求 Spec 未定义的顶层来源字段；最终按冻结模型检查文档级 provider + 逐公式 source。

详细问题规则见 `docs/issues-log.md`。
