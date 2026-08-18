import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime, createTab } from "./helpers/mixcode.js";
import { gitBranchForWorkdir, onGitBranchChange } from "../src/core/git-branch.js";

// Generous deadline: upstream FooterDataProvider polls HEAD at 1000ms with a
// 500ms debounce, and full-suite parallel load stretches both. The wait
// returns as soon as the condition holds, so green runs stay fast.
async function waitForBranch(
  read: () => string | null | undefined,
  timeoutMs = 30_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await Bun.sleep(40);
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
  const bare = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-no-git-"));
  try {
    gitBranchForWorkdir(bare);
    await Bun.sleep(200);
    assert.equal(gitBranchForWorkdir(bare), "");
  } finally {
    await fsPromises.rm(bare, { recursive: true, force: true });
  }
});

test("extension footerData.getGitBranch exposes workdir branch", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-footer-git-"));
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

async function initTempGitRepo(): Promise<string> {
  const workdir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-git-onbranch-"));
  execFileSync("git", ["init", "-q"], { cwd: workdir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: workdir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workdir });
  await fsPromises.writeFile(path.join(workdir, "f"), "x\n");
  execFileSync("git", ["add", "f"], { cwd: workdir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: workdir });
  execFileSync("git", ["branch", "-M", "base-branch"], { cwd: workdir });
  return workdir;
}

test("onGitBranchChange fires when the cached branch value changes", async () => {
  const workdir = await initTempGitRepo();
  let unsub: (() => void) | undefined;
  try {
    // Pi FooterDataProvider resolves sync on first read and only notifies on later changes.
    assert.equal(gitBranchForWorkdir(workdir), "base-branch");
    let fires = 0;
    unsub = onGitBranchChange(workdir, () => {
      fires += 1;
    });

    execFileSync("git", ["checkout", "-qb", "feature-branch"], { cwd: workdir });
    await waitForBranch(() => (fires > 0 ? "ok" : null));
    assert.ok(fires > 0, "expected notify after checkout");
    assert.equal(gitBranchForWorkdir(workdir), "feature-branch");
  } finally {
    unsub?.();
    await fsPromises.rm(workdir, { recursive: true, force: true });
  }
});

test("extension footerData.onBranchChange notifies after branch switch", async () => {
  const workdir = await initTempGitRepo();
  const sessionsRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-footer-onbranch-"));
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

    const before = fires;
    execFileSync("git", ["checkout", "-qb", "ext-feature"], { cwd: workdir });
    await waitForBranch(() => (fires > before ? "ok" : null));
    assert.ok(fires > before, "footer onBranchChange should fire after checkout");
  } finally {
    unsub?.();
    await fsPromises.rm(workdir, { recursive: true, force: true });
    await fsPromises.rm(sessionsRoot, { recursive: true, force: true });
  }
});
