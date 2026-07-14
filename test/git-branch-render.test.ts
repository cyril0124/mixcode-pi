import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createTab } from "../src/core/defaults.js";
import { renderInputMeta } from "../src/ui/rendering/chrome.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("renderInputMeta does not block the event loop on git", async () => {
  const root = mkdtempSync(join(tmpdir(), "mixcode-git-branch-"));
  const workdir = join(root, "repo");
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", workdir, bin]);
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workdir });
  writeFileSync(join(workdir, "f"), "x");
  execFileSync("git", ["add", "f"], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: workdir });
  execFileSync("git", ["branch", "-M", "perf-branch"], { cwd: workdir });

  // Slow git on PATH: branch/rev-parse sleep 400ms (would freeze TUI if sync).
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/bash\nif [[ "$*" == *branch* ]] || [[ "$*" == *rev-parse* ]]; then sleep 0.4; fi\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  try {
    const tab = createTab(1, "s1", workdir);
    const t0 = performance.now();
    renderInputMeta(tab, 120);
    const firstMs = performance.now() - t0;
    assert.ok(firstMs < 80, `first paint blocked ${firstMs.toFixed(1)}ms (must not await git)`);

    // Wait for async refresh, then paint should show the branch name.
    await new Promise((r) => setTimeout(r, 600));
    const painted = stripAnsi(renderInputMeta(tab, 120).join("\n"));
    assert.match(painted, /perf-branch/);
  } finally {
    process.env.PATH = prevPath;
  }
});
