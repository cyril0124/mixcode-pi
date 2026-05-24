--- Simple: open two agents with different tasks.
mixcode.open_tab({
  name = "code-review",
  prompt = "Review all changes in the current branch. Focus on correctness and security.",
})

mixcode.open_tab({
  name = "test-writer",
  prompt = "Write unit tests for any untested public functions in src/.",
})
