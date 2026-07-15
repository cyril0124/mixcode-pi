import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createTab } from "../src/index.js";
import { gitBranchForWorkdir } from "../src/core/git-branch.js";

async function waitForBranch(
  read: () => string | null | undefined,
  timeoutMs = 3_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return read() ?? null;
}

test("gitBranchForWorkdir returns current branch for a git workdir", async () => {
  const repoRoot = process.cwd();
  // Kick the async cache; first paint may be empty.
  gitBranchForWorkdir(repoRoot);
  const branch = await waitForBranch(() => gitBranchForWorkdir(repoRoot) || null);
  assert.ok(branch, "expected a git branch for the repo workdir");
  assert.match(branch, /^[^\s]+$/);
});

test("gitBranchForWorkdir stays empty outside a git repo", async () => {
  const bare = await mkdtemp(join(tmpdir(), "mixcode-no-git-"));
  try {
    gitBranchForWorkdir(bare);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(gitBranchForWorkdir(bare), "");
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test("extension footerData.getGitBranch exposes workdir branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-footer-git-"));
  let readBranch: (() => string | null) | undefined;

  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setFooter((_tui, _theme, footerData) => {
        readBranch = () => footerData.getGitBranch();
        return {
          render: () => [`branch=${footerData.getGitBranch() ?? "-"}`],
          invalidate: () => undefined,
        };
      });
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
    });

    assert.ok(readBranch, "setFooter should capture footerData reader");
    const branch = await waitForBranch(readBranch);
    assert.ok(branch, "footerData.getGitBranch() should resolve for a git workdir");
    assert.equal(branch, gitBranchForWorkdir(process.cwd()) || null);

    // Non-git workdir tab stays null after refresh window.
    const bare = await mkdtemp(join(tmpdir(), "mixcode-footer-no-git-"));
    try {
      let bareRead: (() => string | null) | undefined;
      const bareExt: ExtensionFactory = (pi) => {
        pi.on("session_start", async (_event, ctx) => {
          ctx.ui.setFooter((_tui, _theme, footerData) => {
            bareRead = () => footerData.getGitBranch();
            return { render: () => [], invalidate: () => undefined };
          });
        });
      };
      const bareRuntime = new MixCodeRuntime({
        sessionsRoot: join(dir, "bare-sessions"),
        extensionFactories: [bareExt],
      });
      await bareRuntime.createTab(createTab(2, "s2", bare), {
        systemPrompt: "system",
        thinkingLevel: "off",
        workdir: bare,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(bareRead?.() ?? null, null);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
