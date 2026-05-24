--- Model comparison: same prompt, different models side by side.
local prompt = "Explain the trade-offs between event sourcing and CRUD for a todo app. Be concise."

local models = {
  { name = "sonnet-answer", model = "anthropic/claude-sonnet-4-20250514", thinking = "off" },
  { name = "sonnet-think", model = "anthropic/claude-sonnet-4-20250514", thinking = "high" },
}

for _, cfg in ipairs(models) do
  mixcode.open_tab({
    name = cfg.name,
    prompt = prompt,
    model = cfg.model,
    thinking = cfg.thinking,
  })
end
