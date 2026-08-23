import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-same-"));
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection proceeds when workdir actually changes", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-change-"));
  const next = path.join(root, "other");
  await fsPromises.writeFile(path.join(root, ".keep"), "");
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
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection without runtime updates workdir or toasts same-dir", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-nort-"));
  const next = path.join(root, "other");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(next);
  try {
    const tab = makeTab(root);

    applyWorkdirSelection(tab, next);
    assert.equal(tab.workdir, next);
    // Read into a local: assert.equal is `asserts actual is T`, so asserting on
    // tab.toast directly would pin it to undefined for the rest of this test.
    const toastAfterMove = tab.toast;
    assert.equal(toastAfterMove, undefined);

    applyWorkdirSelection(tab, next);
    assert.equal(tab.workdir, next);
    assert.equal(tab.toast?.message, "workdir unchanged");
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection rejects missing paths without calling runtime", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-missing-"));
  try {
    const tab = makeTab(root);
    let called = false;
    const runtime = {
      updateTabWorkdir: async () => {
        called = true;
      },
    };

    applyWorkdirSelection(tab, path.join(root, "does-not-exist"), runtime);

    assert.equal(called, false);
    assert.equal(tab.workdir, root);
    assert.match(tab.toast?.message ?? "", /workdir not found or not a directory/);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("applyWorkdirSelection rejects files and resolves relative paths", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-rel-"));
  const file = path.join(root, "not-a-dir.txt");
  const child = path.join(root, "child");
  const { mkdir } = await import("node:fs/promises");
  await fsPromises.writeFile(file, "x");
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
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
