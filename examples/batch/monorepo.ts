/// <reference path="../../mixcode-batch.d.ts" />
// Monorepo: one lint agent per package. Packages come from CLI args after `--`,
// falling back to a default set:
//
//   mpi --batch examples/batch/monorepo.ts -- packages/core packages/cli

const script: MixCodeBatchScript = (mixcode) => {
  const packages = mixcode.args();
  const targets = packages.length > 0 ? packages : ["packages/core", "packages/cli"];

  for (const target of targets) {
    const name = target.split("/").pop() ?? target;
    mixcode.openTab({
      name: `${name}-lint`,
      workdir: target,
      thinking: "low",
      prompt: `Run lint and typecheck for the \`${name}\` package. Fix all errors without changing behavior.`,
    });
  }

  mixcode.openTab({
    name: "summary",
    prompt: mixcode.render("Summarize lint results across {count} package(s) in {workdir}.", {
      count: targets.length,
      workdir: mixcode.currentWorkdir(),
    }),
  });
};

export default script;
