import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createTab } from "../src/index.js";
import { gitBranchForWorkdir, onGitBranchChange } from "../src/core/git-branch.js";

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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function initTempGitRepo(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "mixcode-git-onbranch-"));
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workdir });
  await writeFile(join(workdir, "f"), "x\n");
  execFileSync("git", ["add", "f"], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: workdir });
  execFileSync("git", ["branch", "-M", "base-branch"], { cwd: workdir });
  return workdir;
}

test("onGitBranchChange fires when the cached branch value changes", async () => {
  const workdir = await initTempGitRepo();
  try {
    // Pi FooterDataProvider resolves sync on first read and only notifies on later changes.
    assert.equal(gitBranchForWorkdir(workdir), "base-branch");
    let fires = 0;
    const unsub = onGitBranchChange(workdir, () => {
      fires += 1;
    });

    execFileSync("git", ["checkout", "-qb", "feature-branch"], { cwd: workdir });
    await waitForBranch(() => (fires > 0 ? "ok" : null), 6_000);
    assert.ok(fires > 0, "expected notify after checkout");
    assert.equal(gitBranchForWorkdir(workdir), "feature-branch");
    unsub();
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("extension footerData.onBranchChange notifies after branch switch", async () => {
  const workdir = await initTempGitRepo();
  const sessionsRoot = await mkdtemp(join(tmpdir(), "mixcode-footer-onbranch-"));
  let fires = 0;
  let unsub: (() => void) | undefined;

  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setFooter((_tui, _theme, footerData) => {
        unsub = footerData.onBranchChange(() => {
          fires += 1;
        });
        return {
          render: () => [`branch=${footerData.getGitBranch() ?? "-"}`],
          invalidate: () => undefined,
        };
      });
    });
  };

  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot,
      extensionFactories: [extension],
    });
    await runtime.createTab(createTab(1, "s1", workdir), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir,
    });

    await waitForBranch(() => (fires > 0 ? "ok" : null));
    const before = fires;
    execFileSync("git", ["checkout", "-qb", "ext-feature"], { cwd: workdir });
    await waitForBranch(() => (fires > before ? "ok" : null), 6_000);
    assert.ok(fires > before, "footer onBranchChange should fire after checkout");
    unsub?.();
  } finally {
    await rm(workdir, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});
