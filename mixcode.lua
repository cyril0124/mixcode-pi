---@meta

---MixCode batch execution API.
---Available as global `mixcode` table in --batch scripts.
---@class mixcode
mixcode = {}

---@class mixcode.OpenTabOptions
---@field name string Tab title (used for matching existing tabs)
---@field prompt string Prompt text to send to the agent
---@field workdir? string Working directory (defaults to current workdir)
---@field model? string Model identifier (e.g. "anthropic/claude-sonnet-4-20250514")
---@field thinking? "off"|"minimal"|"low"|"medium"|"high"|"xhigh" Thinking level
---@field mode? "append"|"clear" Reuse behavior when tab exists (default: "append")

---Open a new agent tab or reuse an existing one by exact title match.
---If a tab with the same `name` already exists:
---  - mode="append" (default): prompt is appended to the existing session
---  - mode="clear": session is cleared first, then prompt is sent
---If no matching tab exists, a new tab is created.
---
---Throws on failure (missing fields, unknown model, invalid thinking level).
---@param opts mixcode.OpenTabOptions
function mixcode.open_tab(opts) end
