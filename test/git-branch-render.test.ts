import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createTab } from "../src/core/defaults.js";
import { renderInputMeta } from "../src/ui/rendering/chrome.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

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

  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  try {
    const tab = createTab(1, "s1", workdir);
    const t0 = performance.now();
    renderInputMeta(tab, 120);
    const firstMs = performance.now() - t0;
    assert.ok(firstMs < 80, `first paint blocked ${firstMs.toFixed(1)}ms (must not await git)`);

    // Wait for async refresh, then paint should show the branch name.
    await Bun.sleep(600);
    const painted = stripAnsi(renderInputMeta(tab, 120).join("\n"));
    assert.match(painted, /perf-branch/);
  } finally {
    process.env.PATH = prevPath;
  }
});
