# PaperLens 问题记录

### 2026-07-22：浏览器冒烟误用了陈旧构建
- **出现位置**：MinerU Epic B 最终闭环；`.output/chrome-mv3` 早于 `App.tsx` 最新修改。
- **问题**：测试脚本复制旧构建后等待 OCR，源码已经接入 MinerU，但浏览器运行的产物尚未包含接线，导致服务端始终没有 job。
- **最终解法**：重建后再执行；所有浏览器测试脚本改为先自动运行 `pnpm build`。
- **可复用规则**：浏览器 E2E 必须由同一命令生成并消费构建产物，不允许把“曾经 build 过”当作当前源码的验收证据。

### 2026-07-22：原生 fetch 被当作实例方法调用
- **出现位置**：`src/mineru/client.ts` 的真实 Edge localhost 请求。
- **问题**：`fetch` 保存到实例字段后用 `this.fetchImpl(...)` 调用，浏览器把 client 实例作为接收者，在网络请求前抛出 `Illegal invocation`；Node fetch mock 未复现。
- **最终解法**：默认原生 fetch 在构造时绑定到 `globalThis`，并新增浏览器式接收者单元测试。
- **可复用规则**：浏览器原生 Web API 若保存为回调，必须显式绑定合法全局接收者；Node mock 通过不能替代真实浏览器调用约定。

### 2026-07-22：浏览器测试断言越过冻结数据模型
- **出现位置**：MinerU E2E 的来源标识检查。
- **问题**：测试要求并不存在于 Spec 的 `PaperContent.recognitionSource`，而冻结模型只规定逐公式 `recognitionSource` 与文档级 `formulaRecognition.provider`。
- **最终解法**：保留 TypeScript 对模型扩张的拦截，测试改为检查文档级 provider 与逐公式来源。
- **可复用规则**：E2E 断言新增字段前必须回看冻结 Spec 与类型契约；测试不得自行扩张产品模型。
