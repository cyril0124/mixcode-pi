--- CLI args example.
--- Usage: mixcode-pi --batch examples/batch/args.lua -- pkg-a pkg-b pkg-c
local packages = mixcode.args()
if #packages == 0 then
  packages = { "core", "cli" }
end

for _, pkg in ipairs(packages) do
  mixcode.open_tab({
    name = "lint-" .. pkg,
    prompt = render("Run lint for {pkg} and fix errors only.", { pkg = pkg }),
    thinking = "low",
  })
end

-- Pre-open an empty tab without submitting a prompt.
mixcode.open_tab({ name = "scratch" })
