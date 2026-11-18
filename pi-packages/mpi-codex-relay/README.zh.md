# Codex 中转

`codex-relay` 使用 `~/.codex/auth.json` 中的访问令牌向配置的中转服务发出请求。只使用你信任且愿意交付该令牌的中转服务。

1. 确保 `codex` 在 `PATH` 上，并使用 Codex CLI 登录。
2. 将 `~/.codex/config.toml` 顶层的 `openai_base_url` 设为中转服务的绝对 HTTPS 基础地址。
3. 启动 Pi，从 `codex-relay` 选择模型。

如果启动时配置检查失败，扩展会输出警告并跳过 provider 注册。
