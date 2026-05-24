--- Multi-module: spawn one agent per module for parallel work.
local modules = { "auth", "api", "database", "ui" }

for _, mod in ipairs(modules) do
  mixcode.open_tab({
    name = mod .. "-agent",
    prompt = string.format(
      "You are responsible for the `%s` module. "
        .. "Scan src/%s/ for bugs, code smells, and missing error handling. "
        .. "Fix what you find.",
      mod,
      mod
    ),
    workdir = ".",
    thinking = "high",
  })
end
