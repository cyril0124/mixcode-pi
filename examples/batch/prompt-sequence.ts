/// <reference path="../../mixcode-batch.d.ts" />
// Enqueue exclusive agent rounds in one tab with prompts.
// Preview: mpi --batch examples/batch/prompt-sequence.ts --batch-dry-run
// Apply returns after enqueueing, not after the agent finishes.

const script: MixCodeBatchScript = (mixcode) => {
  mixcode.openTab({
    name: "review-sequence",
    prompts: [
      "Review the current branch for correctness issues. Do not edit.",
      "Check the previous findings against the code. Remove unsupported claims. Do not edit.",
      "Summarize the confirmed findings with file references and suggested fixes. Do not edit.",
      "/color green",
    ],
  });
};

// A paused queue stays paused; use /follow-up-next without text to resume.
export default script;
