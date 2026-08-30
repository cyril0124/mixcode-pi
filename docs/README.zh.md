# MixCode Pi 官方技术文档

[English Documentation](README.md)

MixCode Pi 官方技术文档库。记录核心架构、特色工作流、命令清单与配置规范。

## 架构与界面交互

- **[系统架构 (Architecture)](architecture.zh.md)**：总体分层结构、运行时事件映射与全局界面布局。
- **[TUI 组件目录 (TUI Components)](tui-components.zh.md)**：全屏帧布局、Chrome 元素与组件所有权边界。
- **[窄屏与移动终端优化 (Narrow & Mobile)](narrow-terminals-and-mobile.zh.md)**：UI 逐级平滑降级、Tab 溢出压缩与移动端触控/点击交互。
- **[快捷键与热键映射 (Keybindings)](keybindings-and-escape.zh.md)**：核心快捷键、命令面板、外部编辑器与 Escape 撤回流。
- **[鼠标交互与可点击区域 (Mouse Support)](mouse-support.zh.md)**：SGR 1006 鼠标协议、Tab 标签/选择器点击、滚动条拖拽与文本划选复制。
- **[CLI 命令行与参数 (CLI & Flags)](cli-and-flags.zh.md)**：`mpi` 参数选项 (`--workdir`, `--builtin-extensions-only`, `--batch`)、`status` / `ctl`（Agent Tab 协作）与委托规则。

## 核心特色功能与工作流

- **[内置扩展总览 (Built-in Extensions)](builtin-extensions.zh.md)**：第一方 `mpi-*` 扩展目录与运行时加载生命周期（具体各扩展详情见 `pi-packages/<name>/README.md`）。
- **[Zen 专注模式与后台感知 (Zen Mode)](zen-mode.zh.md)**：极简专注视图、后台状态圆点感知与跨 Tab 模式自动迁移。
- **[内联组件模式 (`[INL]`)](inline-widgets.zh.md)**：扩展组件随 Chat 消息流自然滚动与编辑器垂直空间扩展。
- **[Vim 模式与对话导航 (Vim & Navigation)](vim-and-navigation.zh.md)**：Buffer 级浏览与用户提问正反向跳转。
- **[多标签与工作区管理 (Workspace & Tabs)](workspace-and-tabs.zh.md)**：多 Tab 工作流、`/reset` 与 `/clear` 差异、`/fork`、工作区布局持久化，以及 Agent Tab 协作（`mpi ctl`）。
- **[转向与后续双队列 (Queue Management)](queue-and-follow-up.zh.md)**：轮次中 Steer 注入、轮次后 Follow-up 排队与 `Ctrl+U` 出队。
- **[Batch 批量自动化执行](batch-scripts.zh.md)**：启动后 Monorepo 批量脚本（Lua / TypeScript）、API 规范及 dry-run 校验。

## 配置、模型与生态集成

- **[Slash 命令手册 (Commands)](commands.zh.md)**：三级持久化分类（Global / Workdir / Session）与常用命令清单。
- **[配置管理 (`mixcode_settings.json`)](mixcode-settings.zh.md)**：用户配置 Schema、主题 ID 与厂商/模型禁用策略。
- **[模型管理与动态规则 (Model Management)](model-management.zh.md)**：Provider 配置、思考深度档位与基于模型的动态 Skill/Extension 挂载。
- **[环境变量清单 (Environment Variables)](environment.zh.md)**：面向用户的产品级 `MIXCODE_*` 变量及工具子进程注入规则。
- **[Pi 扩展生态兼容性 (Pi Compatibility)](extension-compatibility.zh.md)**：L0–L3 兼容分级与 Pi Packages 生命周期对接。
- **[实例监控与注册表 (Instance Registry)](instance-registry.zh.md)**：`mpi status` 监控与跨进程实例追踪。
- **[扩展 UI 体系与组件 (Extension UI)](extension-ui-and-widgets.zh.md)**：4 大专属挂载区、widget 侧边面板与内联组件模式 (`/toggle-inline-widgets`)。
