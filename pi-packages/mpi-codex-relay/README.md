# Codex Relay

The `codex-relay` provider sends requests to the configured relay using the access token from `~/.codex/auth.json`. Use a relay you trust to receive that token.

1. Put `codex` on `PATH` and log in with the Codex CLI.
2. Set the top-level `openai_base_url` in `~/.codex/config.toml` to your relay's absolute HTTPS base URL.
3. Start Pi and select a model from `codex-relay`.

If setup fails at startup, the extension logs a warning and skips provider registration.
