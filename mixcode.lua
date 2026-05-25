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

---@class mixcode.TabInfo
---@field name string Tab title
---@field session_id string Runtime session id
---@field workdir string Tab working directory
---@field model string Model display name
---@field thinking "off"|"minimal"|"low"|"medium"|"high"|"xhigh" Thinking level
---@field status string Tab status

---Open a new agent tab or reuse an existing one by exact title match.
---If a tab with the same `name` already exists:
---  - mode="append" (default): prompt is appended to the existing session
---  - mode="clear": session is cleared first, then prompt is sent
---If no matching tab exists, a new tab is created.
---
---Throws on failure (missing fields, unknown model, invalid thinking level).
---@param opts mixcode.OpenTabOptions
function mixcode.open_tab(opts) end

---Return the current MixCode workdir.
---@return string
function mixcode.current_workdir() end

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
