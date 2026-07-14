---@meta

---MixCode batch execution API.
---Available as global `mixcode` table in --batch scripts.
---@class mixcode
mixcode = {}

---@class mixcode.OpenTabOptions
---@field name string Tab title (used for matching existing tabs)
---@field prompt? string Prompt text to send; omit to create/reuse tab without submitting
---@field workdir? string Working directory (defaults to current workdir)
---@field model? string Model identifier (e.g. "anthropic/claude-sonnet-4-20250514")
---@field thinking? "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" Thinking level supported by the selected model
---@field mode? "append"|"clear"|"delete" Reuse behavior when tab exists (default: "append")

---@class mixcode.TabInfo
---@field name string Tab title
---@field session_id string Runtime session id
---@field workdir string Tab working directory
---@field model string Model display name
---@field thinking "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" Thinking level
---@field status string Tab status

---Open a new agent tab or reuse an existing one by exact title match.
---If a tab with the same `name` already exists:
---  - mode="append" (default): prompt is appended to the existing session
---  - mode="clear": session is cleared first, then prompt is sent
---  - mode="delete": tab and its session file are deleted, then a brand-new tab is created
---If no matching tab exists, a new tab is created.
---If `prompt` is omitted, the tab is created/reused/cleared/deleted without submitting input.
---
---Throws on failure (missing name, unknown model, invalid thinking level).
---@param opts mixcode.OpenTabOptions
function mixcode.open_tab(opts) end

---Return the current MixCode workdir.
---@return string
function mixcode.current_workdir() end

---Return CLI args after `--` as a 1-indexed array.
---Example: `mixcode-pi --batch s.lua -- foo bar` → `{"foo", "bar"}`.
---@return string[]
function mixcode.args() end

---Return whether a tab with the exact title exists at batch startup.
---@param name string
---@return boolean
function mixcode.tab_exists(name) end

---List tabs visible at batch startup.
---@return mixcode.TabInfo[]
function mixcode.list_tabs() end

---Render a string template using `{name}` placeholders.
---Use `{{` and `}}` to output literal braces.
---Missing variables and invalid placeholder names raise an error.
---@param template string
---@param vars table<string, any>
---@return string
function mixcode.render(template, vars) end

---Global shorthand for `mixcode.render`.
---@param template string
---@param vars table<string, any>
---@return string
function render(template, vars) end
