--- File-driven: read prompts from external files.
local function read_file(path)
  local f = io.open(path, "r")
  if not f then error("Cannot open file: " .. path) end
  local content = f:read("*a")
  f:close()
  return content
end

-- Each .md file in prompts/ becomes an agent tab
local agents = {
  { name = "refactor-agent", file = "prompts/refactor.md" },
  { name = "docs-agent", file = "prompts/write-docs.md" },
  { name = "perf-agent", file = "prompts/optimize.md" },
}

for _, agent in ipairs(agents) do
  mixcode.open_tab({
    name = agent.name,
    prompt = read_file(agent.file),
    thinking = "medium",
  })
end
