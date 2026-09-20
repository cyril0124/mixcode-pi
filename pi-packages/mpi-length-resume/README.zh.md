# mpi-length-resume

[English](README.md)

当回答因输出长度上限中断时，若原生自动压缩完成且不会重试，或本轮结束时仍接近上下文上限，扩展自动续跑。续跑使用隐藏 custom 消息，压缩由 Pi 负责。若接近上限时反复出现很短的截断回答，则切换到直接给出最终答案的提示词，随后停止续跑。

扩展从全局 `<agentDir>/settings.json` 与项目 `<cwd>/.pi/settings.json` 读取 `compaction.reserveTokens` 和 `compaction.modelOverrides["provider/modelId"].reserveTokens`。同一设置中项目值覆盖全局值；合并后的模型预算优先于普通预算。模型预算允许为零。未配置时使用 Pi 默认预留量；若预留量覆盖整个模型窗口，则调整为窗口的 10%。

`ctx.model.contextWindow` 提供实时窗口大小。扩展无法读取宿主 SettingsManager 的内存覆盖，所用配置预算来自磁盘。不注册命令或独立配置文件。
