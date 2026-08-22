import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// This file must not mutate process.env.PATH: bun test --parallel runs many
// test files concurrently inside one `--test-worker` process, and a swapped
// PATH (with a slow fake git) poisons every concurrent file that spawns git
// (footer-git-branch, bootstrap, …) — observed as 60s starvations and a
// CPU-spinning worker with an unreaped zombie git child in CI. The
// PATH-scoped render assertions run in a child bun process instead
// (test/helpers/git-branch-render-scenario.ts).

test("renderInputMeta does not block the event loop on git", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixcode-git-branch-"));
  const workdir = path.join(root, "repo");
  const bin = path.join(root, "bin");
  execFileSync("mkdir", ["-p", workdir, bin]);
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workdir });
  fs.writeFileSync(path.join(workdir, "f"), "x");
  execFileSync("git", ["add", "f"], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: workdir });
  execFileSync("git", ["branch", "-M", "perf-branch"], { cwd: workdir });

  // Slow git on PATH: branch/rev-parse sleep 400ms (would freeze TUI if sync).
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/bash\nif [[ "$*" == *branch* ]] || [[ "$*" == *rev-parse* ]]; then sleep 0.4; fi\nexec "${realGit}" "$@"\n`,
  );
  fs.chmodSync(path.join(bin, "git"), 0o755);

  const result = Bun.spawnSync(
    [process.execPath, path.join(import.meta.dir, "helpers", "git-branch-render-scenario.ts"), workdir],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  assert.equal(result.exitCode, 0, `scenario child failed: ${result.stderr?.toString() ?? ""}`);
  const report = JSON.parse(result.stdout.toString().trim()) as { firstMs: number; painted: string };
  assert.ok(
    report.firstMs < 80,
    `first paint blocked ${report.firstMs.toFixed(1)}ms (must not await git)`,
  );
  assert.match(report.painted, /perf-branch/);
});
