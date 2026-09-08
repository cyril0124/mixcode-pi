# GIF recorder model configuration

Copy `scripts/record-readme-gifs.example.json` to `scripts/record-readme-gifs.local.json` and replace the placeholders with your provider and model IDs. Git ignores the local file. Run `python3 scripts/record-readme-gifs.py` for all shots, or append shot names such as `zen`.

The local JSON accepts only `provider` and `model`, both non-empty strings. `MIXCODE_GIF_PROVIDER` and `MIXCODE_GIF_MODEL` override their respective fields. No model defaults are built in. The file is optional if both environment variables are set. Invalid JSON, unknown keys, invalid types, or missing effective values stop execution before recording; an invalid file is rejected even when environment overrides exist.

Do not store API keys here. Authentication uses the existing agent directory. The recorder does not print the configured provider/model IDs at startup. Tool diagnostics, model responses, and recorded UI may still contain private values; inspect generated GIFs before publishing.

## Recording resources

Install `python3`, `git`, `bun`, `tmux`, `asciinema`, and `agg` before running the recorder. The demo input is `demo/readme-todo/`. The recorder builds the CLI when needed and writes GIFs to `assets/readme-<shot>.gif`.

Each shot uses a private temporary directory and a unique tmux server name. It links `auth.json`, `keys`, and `models.json` from `MIXCODE_GIF_SOURCE_AGENT_DIR`, which defaults to `~/.pi/agent`. Relative paths resolve against the recorder's launch directory; `~` is expanded. These source files stay outside the repository. Widget shots also use the installed `npm:@tintinweb/pi-tasks` package from that agent directory.

The `vim`, `inline-widget`, and `skill` shots load `scripts/readme-recorder-observer.ts` from their temporary agent directory. These scenarios keep one agent tab. Before each submitted prompt, the recorder assigns a request ID. The observer binds that ID at `before_agent_start` and publishes the final assistant response only at `agent_settled`, after retries and automatic continuations. Completion files stay in the shot's private directory and are removed during cleanup.

Each model request has a 120-second deadline. Old completions, user-message echoes, and `Working` text cannot complete a request. Errors, cancellation, truncated or empty answers fail the shot. Chat seeding requires the requested word before submitting the next prompt; the skill shot requires both open demo TODO titles in the completed answer. Widget shots require task content, and an agent-focus timeout fails the scenario.

On completion, failure, SIGINT, or SIGTERM, the recorder stops its child process groups and its own tmux servers, then removes temporary authentication links, sessions, and casts. Other tmux servers and the source authentication files are not deleted. SIGKILL and machine failure cannot run this cleanup. A scenario timeout fails the shot; the recorder writes the success stamp only after all requested shots succeed.
