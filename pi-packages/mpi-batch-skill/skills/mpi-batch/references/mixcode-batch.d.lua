---@meta

---MixCode batch execution API.
---Available as global `mixcode` table in startup --batch and current-TUI /batch scripts.
---Lua rereads and executes the file on each invocation.
---@class mixcode
mixcode = {}

---@class mixcode.OpenTabOptions
---@field name string Tab title (used for matching existing tabs)
---@field prompt? string Prompt to submit; omit to create/reuse/clear/delete without submitting. Supports skills, templates, extension commands, and !shell / !!shell. Registered MixCode local commands, including /batch, fail at dispatch. Other slash input and paths pass unchanged to Pi; unmatched input becomes message text.
---@field workdir? string New-tab directory; defaults and relative paths use current_workdir(). Reuse/clear keeps the existing directory
---@field model? string Model identifier from list_models().id; omitted means keep existing or use the instance default for a new tab
---@field thinking? "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" Supported thinking level; omitted means keep existing or use the instance default for a new tab
---@field context_limit? number|string Session context budget: positive safe integer tokens or a /context-limit string such as "32000", "32k", "32.5k", or "reset"; nil means omitted. See open_tab for parsing and application rules.
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

---Collect a tab request. MixCode applies it after the script finishes.
---If a tab with the same `name` already exists:
---  - mode="append" (default): continue the session; streaming prompts use steering
---  - mode="clear": reset the branch to session root, then send prompt; keep title, session id/file, workdir, system prompt, and focus. History stays in /tree, outside the new context. No extension reload or service rebuild; rejected while streaming or bash is running.
---  - mode="delete": tab and its session file are deleted, then a brand-new tab is created
---If no matching tab exists, a new tab is created. New tabs and delete replacements take focus.
---Setup failures stop before prompt dispatch. During parallel dispatch, other
---groups continue after one fails. Applied changes remain in both cases.
---See ../SKILL.md#execution-and-errors for command errors and persistence.
---If `prompt` is omitted, the tab is created/reused/cleared/deleted without submitting input.
---`system_prompt` replaces only the base identity line; tools/guidelines, APPEND_SYSTEM,
---project context (AGENTS.md), and skills remain. It is rejected when reusing an existing
---session with mode="append", or with mode="clear" even without a matching tab.
---Clear + system_prompt (including an empty string) fails validation before any tab changes.
---For repeated names, only the first request controls creation/reset/deletion.
---Interactive /clear still replaces the session and resets its title.
---Each request applies model/thinking, then context_limit, then its optional prompt.
---context_limit works in all modes, including requests without a prompt and later same-name requests.
---Strings trim whitespace, ignore case, and use /context-limit numeric rounding;
---resulting tokens must be positive safe integers. "reset" restores the selected model's canonical window.
---Omission uses the model default for new tabs and retains a reused tab's limit unless explicit model selection resets it.
---The limit synchronizes session contextWindow, UI, and compaction budgets for this session only; no global config change.
---Above-capacity values warn without expanding provider capacity.
---Invalid context_limit values fail before any tab changes with Error: and the tab name; the script loader adds the script path.
---
---Throws on a missing name, invalid option types or context_limit. Model, thinking,
---mode, and system_prompt validation happens after collection, before tab changes.
---@param opts mixcode.OpenTabOptions
function mixcode.open_tab(opts) end

---Return the invocation directory: calling Agent tab workdir for /batch,
---instance workdir on Home, launch workdir for CLI. Also resolves the script path
---and new-tab workdirs. Does not change process.cwd(); script-owned relative I/O uses host cwd.
---@return string
function mixcode.current_workdir() end

---Return args after `--` in startup CLI or /batch as a 1-indexed array.
---Example: `/batch s.lua -- foo ""` yields {"foo", ""}.
---/batch supports quotes and backslash escaping except inside single quotes;
---no shell variable, command, or glob expansion occurs.
---@return string[]
function mixcode.args() end

---Return whether a tab with the exact title exists in this invocation's snapshot.
---@param name string
---@return boolean
function mixcode.tab_exists(name) end

---List tabs captured before this invocation (snapshot; not live).
---@return mixcode.TabInfo[]
function mixcode.list_tabs() end

---Resolve an exact model id or provider/modelId to an enabled canonical id.
---Uses a fresh invocation snapshot of models, disabled IDs, and the instance default provider.
---Prefer the captured instance default provider, then the smallest provider name
---in case-sensitive JS string order. Canonical references never change routes;
---disabled candidates are excluded from automatic selection.
---Trims surrounding whitespace; throws for invalid/unknown queries or disabled
---explicit references. No I/O, fuzzy matching, or model-version substitution.
---@param query string Exact model id or provider/modelId
---@return string id Canonical provider/modelId, accepted by open_tab
function mixcode.resolve_model(query) end

---List the invocation model catalog (not live); includes disabled entries without a disabled field.
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
