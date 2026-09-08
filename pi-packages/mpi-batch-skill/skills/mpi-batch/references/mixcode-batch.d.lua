---@meta

---MixCode batch execution API.
---Available as global `mixcode` table in --batch scripts.
---@class mixcode
mixcode = {}

---@class mixcode.OpenTabOptions
---@field name string Tab title (used for matching existing tabs)
---@field prompt? string Prompt to submit; omit to create/reuse/clear/delete without submitting. Supports skills, templates, extension commands, and !shell / !!shell. Registered MixCode local commands fail at dispatch. Pi handles other slash input; unmatched input, including paths, becomes message text.
---@field workdir? string Working directory for new tabs (defaults to launch workdir); reuse/clear keeps the existing directory
---@field model? string Model identifier from list_models().id; omitted means keep existing or use launch model for a new tab
---@field thinking? "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" Supported thinking level; omitted means keep existing or use launch default for a new tab
---@field system_prompt? string Base/identity system prompt only (same slot as SYSTEM.md). Tools, AGENTS.md, and skills stay assembled by MixCode. Requires a new tab or mode="delete"; rejected with mode="clear" even without a matching tab.
---@field mode? "append"|"clear"|"delete" Reuse behavior when tab exists (default: "append")

---@class mixcode.TabInfo
---@field name string Tab title
---@field session_id string Runtime session id
---@field workdir string Tab working directory
---@field model string Model display name, not necessarily a canonical provider/model_id
---@field thinking "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" Thinking level
---@field status string Tab status

---@class mixcode.ModelInfo
---@field id string Canonical id (`provider/model_id`)
---@field provider string Provider id
---@field model_id string Model id within the provider
---@field display_name string Display name shown in the UI
---@field context_window number Context window size
---@field reasoning boolean Whether the model supports reasoning/thinking

---Open a new agent tab or reuse an existing one by exact title match.
---If a tab with the same `name` already exists:
---  - mode="append" (default): prompt is appended to the existing session
---  - mode="clear": reset the branch to session root, then send prompt; keep title, session id/file, workdir, and system prompt. History stays in /tree, outside the new context. No extension reload or service rebuild; rejected while streaming or bash is running.
---  - mode="delete": tab and its session file are deleted, then a brand-new tab is created
---If no matching tab exists, a new tab is created.
---If `prompt` is omitted, the tab is created/reused/cleared/deleted without submitting input.
---`system_prompt` replaces only the base identity line; tools/guidelines, APPEND_SYSTEM,
---project context (AGENTS.md), and skills remain. It is rejected when reusing an existing
---session with mode="append", or with mode="clear" even without a matching tab.
---Clear + system_prompt (including an empty string) fails validation before any tab changes.
---For repeated names, only the first request controls creation/reset/deletion.
---Interactive /clear still replaces the session and resets its title.
---
---Throws on failure (missing name, unknown model, invalid thinking level, invalid system_prompt use).
---@param opts mixcode.OpenTabOptions
function mixcode.open_tab(opts) end

---Return the current MixCode workdir.
---@return string
function mixcode.current_workdir() end

---Return CLI args after `--` as a 1-indexed array.
---Example: `mpi --batch s.lua -- foo bar` → `{"foo", "bar"}`.
---@return string[]
function mixcode.args() end

---Return whether a tab with the exact title exists at batch startup.
---@param name string
---@return boolean
function mixcode.tab_exists(name) end

---List tabs visible at batch startup.
---@return mixcode.TabInfo[]
function mixcode.list_tabs() end

---Resolve an exact model id or provider/modelId to an enabled canonical id.
---Uses the startup snapshot: prefer its default provider, then provider name
---in case-sensitive JS string order. Canonical references never change routes.
---Trims surrounding whitespace; throws for invalid/unknown queries or disabled
---explicit references. No I/O, fuzzy matching, or model-version substitution.
---@param query string Exact model id or provider/modelId
---@return string id Canonical provider/modelId, accepted by open_tab
function mixcode.resolve_model(query) end

---List available models at batch startup (snapshot; not live).
---@return mixcode.ModelInfo[]
function mixcode.list_models() end

---Render a string template using `{name}` placeholders.
---Use `{{` and `}}` to output literal braces.
---Missing variables, invalid placeholder names, and unmatched braces raise errors.
---Placeholder names must match [A-Za-z_][A-Za-z0-9_]*.
---@param template string
---@param vars table<string, any>
---@return string
function mixcode.render(template, vars) end

---Global shorthand for `mixcode.render`.
---@param template string
---@param vars table<string, any>
---@return string
function render(template, vars) end
