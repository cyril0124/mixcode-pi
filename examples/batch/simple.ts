/// <reference path="../../mixcode-batch.d.ts" />
// Simple: open two agents with different tasks, plus one empty scratch tab.

const script: MixCodeBatchScript = (mixcode) => {
  mixcode.openTab({
    name: "code-review",
    prompt: "Review all changes in the current branch. Focus on correctness and security.",
  });

  mixcode.openTab({
    name: "test-writer",
    prompt: "Write unit tests for any untested public functions in src/.",
  });

  // No prompt: the tab is created but nothing is submitted.
  mixcode.openTab({ name: "scratch" });
};

export default script;
