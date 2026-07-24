import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyWorkdirSelection } from "../src/ui/app-actions.js";
import type { MixCodeState } from "../src/core/types.js";

function makeTab(workdir: string): MixCodeState["tabs"][number] {
  return {
    sessionId: "s1",
    workdir,
    toast: undefined,
  } as unknown as MixCodeState["tabs"][number];
}

test("applyWorkdirSelection skips and toasts when workdir is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-same-"));
  try {
    const tab = makeTab(dir);
    let called = false;
    const runtime = {
      updateTabWorkdir: async () => {
        called = true;
      },
    };

    applyWorkdirSelection(tab, dir, runtime);
    assert.equal(called, false);
    assert.equal(tab.toast?.message, "workdir unchanged");

    applyWorkdirSelection(tab, `${dir}/`, runtime);
    assert.equal(called, false);
    assert.equal(tab.toast?.message, "workdir unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection proceeds when workdir actually changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixcode-workdir-change-"));
  const next = join(root, "other");
  await writeFile(join(root, ".keep"), "");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(next);
  try {
    const tab = makeTab(root);
    let calledWith: string | undefined;
    const runtime = {
      updateTabWorkdir: async (_sessionId: string, workdir: string) => {
        calledWith = workdir;
      },
    };

    applyWorkdirSelection(tab, next, runtime);

    assert.equal(calledWith, next);
    assert.equal(tab.toast, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection without runtime updates workdir or toasts same-dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixcode-workdir-nort-"));
  const next = join(root, "other");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(next);
  try {
    const tab = makeTab(root);

    applyWorkdirSelection(tab, next);
    assert.equal(tab.workdir, next);
    assert.equal(tab.toast, undefined);

    applyWorkdirSelection(tab, next);
    assert.equal(tab.workdir, next);
    assert.equal(tab.toast?.message, "workdir unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection rejects missing paths without calling runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixcode-workdir-missing-"));
  try {
    const tab = makeTab(root);
    let called = false;
    const runtime = {
      updateTabWorkdir: async () => {
        called = true;
      },
    };

    applyWorkdirSelection(tab, join(root, "does-not-exist"), runtime);

    assert.equal(called, false);
    assert.equal(tab.workdir, root);
    assert.match(tab.toast?.message ?? "", /workdir not found or not a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection rejects files and resolves relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixcode-workdir-rel-"));
  const file = join(root, "not-a-dir.txt");
  const child = join(root, "child");
  const { mkdir } = await import("node:fs/promises");
  await writeFile(file, "x");
  await mkdir(child);
  try {
    const tab = makeTab(root);
    let calledWith: string | undefined;
    const runtime = {
      updateTabWorkdir: async (_sessionId: string, workdir: string) => {
        calledWith = workdir;
      },
    };

    applyWorkdirSelection(tab, "not-a-dir.txt", runtime);
    assert.equal(calledWith, undefined);
    assert.equal(tab.workdir, root);
    assert.match(tab.toast?.message ?? "", /workdir not found or not a directory/);

    applyWorkdirSelection(tab, "child", runtime);
    assert.equal(calledWith, child);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
