# Session 摘要：MinerU 薄集成 Epic C2 与发布门

日期：2026-07-23

## 处理的 Issue

- 完成 C2 升级/修复、服务实例所有权、两种卸载与重装恢复。
- 完成 Edge/Chrome for Testing 的上传、`file://` 与真实 MinerU 发布矩阵。
- 更新 `PLAN.md`、集成计划、服务 README、验收记录和问题日志；P3 保持 follow-up。

## 使用的 Skill

- `plan-breakdown`：冻结 C2 生命周期和发布矩阵 P0–P3。
- `execute-implement`：按小段实现状态/停服、安装切换、卸载和验收示例。
- `verify-test`：先写生命周期与 Windows 功能测试，再实现；每段运行相关测试与 compile。
- `verify-review`：提交前按规则与工程双裁决检查。
- `observe-session`：记录真实运行证据、错误与 PR 摘要输入。
- `improve-retro`：复用 PowerShell BOM/PATH 规则，并沉淀 Chrome for Testing 自动化规则。
- `yeet`：限定文件范围提交、推送当前分支并创建 draft PR。

## 关键错误与解法

1. **uv 在 PowerShell 5.1 把正常进度写到 stderr**：验收包装器不再用 `ErrorActionPreference=Stop` 判断原生命令，改为捕获全部输出并只检查退出码，避免泄漏首次 token。
2. **新卸载脚本缺 UTF-8 BOM**：PowerShell 5.1 将中文字符串解析为乱码并报语法错误；按既有规则补 BOM，并保留真实 5.1 功能测试。
3. **端口探测的异步 connect 假阴性**：回环拒绝连接可能晚于 250ms，误报端口占用；改为 `ExclusiveAddressUse` 的临时 `TcpListener` 绑定，直接验证端口所有权。
4. **验收脚本再次遇到 `Path/PATH` 重复**：复用 C1 已沉淀的 .NET 定点重建规则，真实生命周期随后一次通过。
5. **上传测试选到错误同名 PDF**：改用冻结金标目录 `local-artifacts/pdf-ocr-poc/pdfs/`，浏览器恢复 8 位作者与 Attention 标题断言。
6. **正式 Chrome 阻止 unpacked 命令行扩展**：没有放宽测试；下载官方 Chrome for Testing 151 完成自动化，结束后删除 191 MB 压缩包和解压目录。
7. **服务跨命令被 Job Object 回收**：将“服务 + 浏览器 + 卸载 + 端口检查”放入同一命令生命周期，真实验证常驻 worker 的递归停止。
8. **完整清理后的外层验收日志被误报为产品残留**：核对 runtime/data 均已删除、端口空闲、无相关进程；仅删除测试自己创建的外层日志，不修改产品语义。

## 验证结果

- Python 61/61；MinerU client/provider 15/15；PDF 46/46；POC 13/13。
- Windows 生命周期相关 21/21；真实生命周期 159.1 秒通过。
- Edge/Chrome for Testing offline Phase C 与真实 MinerU 均通过；Edge 在线 arXiv 核心 4 项通过。
- 真实 MinerU 两款浏览器均达到 5 条展示公式、108 处行内统计和鉴权 crop；运行中默认卸载/完整清理均释放 worker 与端口。
- `pnpm compile` 在每个实质阶段通过；最终 `pnpm build` 作为提交门执行。

## 返工与降质检查

- 没有降低 P0/P1，也没有用单测替代真实安装、浏览器或进程树验收。
- PowerShell PATH 问题已命中历史重复规则并直接复用；未重复盲改。
- arXiv 后续返回错误页时拆分外部依赖与离线来源矩阵，保留第一次真实在线通过证据，没有把外部失败标为产品通过。
- 当前环境没有可靠 token 用量数据，因此不伪造数值。

## 后续

- P3：系统级后台服务与自动更新。
- 发布人工项：在正式 Chrome 安装打包扩展复验；这不阻塞 unpacked 自动化与当前 PR 评审。
- 本分支只创建 PR 到 `main`，不直接合并。
