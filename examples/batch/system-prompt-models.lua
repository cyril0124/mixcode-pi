--- Base system_prompt (identity only) + list_models snapshot.
--- system_prompt replaces the base persona; tools/AGENTS.md/skills stay assembled.

local models = mixcode.list_models()
local model_id = models[1] and models[1].id or nil

mixcode.open_tab({
  name = "strict-reviewer",
  model = model_id,
  thinking = "medium",
  system_prompt = "You are a strict code reviewer. Focus on bugs, security, and API breaks. Be concise.",
  prompt = "Review the current branch changes and report the top findings.",
})
