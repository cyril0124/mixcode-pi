--- Reuse existing tabs: send follow-up prompts to already-open agents.
--- Requires tabs named "code-review" and "test-writer" to already exist.
mixcode.open_tab({
  name = "code-review",
  prompt = "Review vendor/pi/packages/coding-agent/src/core/session-manager.ts for breaking API changes.",
})

mixcode.open_tab({
  name = "test-writer",
  prompt = "Add integration tests for pi-packages/mpi-bash.",
})
