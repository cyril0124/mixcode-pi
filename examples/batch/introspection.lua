--- Introspection: inspect existing tabs and current workdir before dispatching.
local root = mixcode.current_workdir()

if mixcode.tab_exists("test-1") then
  mixcode.open_tab({
    name = "test-1",
    mode = "clear",
    prompt = "This tab already existed under " .. root .. "; start fresh.",
  })
else
  mixcode.open_tab({
    name = "test-1",
    prompt = "This tab did not exist yet under " .. root .. ".",
  })
end

local summary = {}
for _, tab in ipairs(mixcode.list_tabs()) do
  table.insert(summary, string.format("- %s [%s, %s] %s", tab.name, tab.model, tab.thinking, tab.workdir))
end

mixcode.open_tab({
  name = "tab-audit",
  prompt = "Existing tabs at batch startup:\n" .. table.concat(summary, "\n"),
})
