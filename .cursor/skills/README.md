# Cursor Skills（项目内分享）

本目录存放 **PaperLens 项目沉淀的 Cursor Skill**，供使用 [Cursor IDE](https://cursor.sh) 的开发者在本仓库下自动获得相关领域的开发指引。

## 当前包含的 Skill

| Skill | 适用场景 | 来源 |
|---|---|---|
| [`browser-extension-dev`](./browser-extension-dev/SKILL.md) | 用 **WXT + React + TypeScript + Tailwind** 开发 Chrome / Firefox 浏览器扩展（Manifest V3）。覆盖脚手架、消息通信、BYOK LLM 集成、流式重试、Markdown + KaTeX 渲染、Windows 常见坑等 | PaperLens 项目沉淀 |

## 它是怎么工作的

Cursor 在打开本项目时会**自动扫描** `.cursor/skills/` 目录下所有 `SKILL.md` 文件，并根据每个 skill 的 `description` 字段（YAML front-matter）匹配你与 AI 的对话。例如当你说 "帮我加一个 Manifest V3 的 sidePanel" 时，AI 会自动读取 `browser-extension-dev/SKILL.md` 并按其中的最佳实践产出代码。

不需要任何额外配置。

## 自定义 / 扩展 skill

- 想新增项目专属的 skill：在本目录下新建 `<skill-name>/SKILL.md`，写好 YAML front-matter 的 `name` 和 `description` 即可。
- skill 内容用 Markdown，可以包含代码块、列表、检查清单。
- 推荐参考 Cursor 官方教程：<https://cursor.sh/docs>，或本项目里现有的 `browser-extension-dev` 作为模板。

## 与个人 skill 的区别

| 类型 | 路径 | 范围 | 是否随 git |
|---|---|---|---|
| **项目 skill**（本目录） | `<repo>/.cursor/skills/` | 仅在该项目内启用 | ✅ 随仓库共享 |
| **个人 skill** | `~/.cursor/skills/` | 跨所有项目启用 | ❌ 仅本机 |

如果你在自己机器上做出了通用价值的开发模式总结，欢迎以 PR 形式贡献到本目录！
