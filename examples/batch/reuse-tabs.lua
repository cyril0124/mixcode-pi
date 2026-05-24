--- Reuse existing tabs: send follow-up prompts to already-open agents.
--- Requires tabs named "code-review" and "test-writer" to already exist.
mixcode.open_tab({
  name = "code-review",
  prompt = "Now focus on the changes in src/core/. Are there any breaking API changes?",
})

mixcode.open_tab({
  name = "test-writer",
  prompt = "Add integration tests for the batch-lua module.",
})
