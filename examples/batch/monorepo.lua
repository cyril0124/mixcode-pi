--- Monorepo: open one agent per workspace package.
local packages = {
  { name = "core", path = "packages/core" },
  { name = "cli", path = "packages/cli" },
  { name = "web", path = "packages/web" },
  { name = "shared", path = "packages/shared" },
}

for _, pkg in ipairs(packages) do
  mixcode.open_tab({
    name = pkg.name .. "-lint",
    prompt = string.format(
      "Run lint and typecheck for the `%s` package. Fix all errors without changing behavior.",
      pkg.name
    ),
    workdir = pkg.path,
    thinking = "low",
  })
end
