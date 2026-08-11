import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Both delete paths shell out to the `trash` CLI: mixcode's own copy via
// Bun.spawnSync, pi's via `import { spawnSync } from "node:child_process"`.
// The pi import is a value snapshot taken when the pi module loads, so the
// node:child_process property must be swapped BEFORE any pi module import —
// all pi/mixcode imports below are therefore dynamic.
const trashCalls: string[][] = [];

function fakeTrash(args: string[]): { exitCode: number; status: number; stderr: string } {
  trashCalls.push(args);
  const file = args[1]; // ["trash", sessionPath]
  if (file !== undefined && fs.existsSync(file)) {
    fs.unlinkSync(file);
    return { exitCode: 0, status: 0, stderr: "" };
  }
  return { exitCode: 1, status: 1, stderr: "trash: no such file" };
}

test("deleting a session via the selector invokes trash exactly once", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-delete-once-"));
  const sessionRoot = path.join(root, "sessions");
  await fsPromises.mkdir(sessionRoot, { recursive: true });
  const sessionId = "delete-once-test";
  const sessionPath = path.join(sessionRoot, `2026-08-03T12-00-00-000Z_${sessionId}.jsonl`);
  await fsPromises.writeFile(
    sessionPath,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-03T12:00:00.000Z", cwd: root })}\n`,
  );
  assert.ok(fs.existsSync(sessionPath));

  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process") as {
    spawnSync: (...args: unknown[]) => unknown;
  };
  const originalNodeSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = ((cmd: string, args?: string[]) =>
    fakeTrash([cmd, ...(args ?? [])])) as never;
  const originalBunSpawnSync = Bun.spawnSync;
  // mixcode's delete path calls Bun.spawnSync(["trash", ...args]).
  (Bun as unknown as { spawnSync: unknown }).spawnSync = ((cmd: string[]) =>
    fakeTrash(cmd)) as never;

  try {
    const [{ createInitialState, createTab }, { openSessionSelector }, { SessionSelectorComponent }] =
      await Promise.all([
        import("../src/index.js"),
        import("../src/ui/session-selector.js"),
        import("@earendil-works/pi-coding-agent"),
      ]);

    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"));
    state.activeTabId = "s1";
    let mounted: unknown;
    const input = {
      setInputComponent: (component: unknown) => {
        mounted = component;
      },
      clearInputComponent: () => {
        mounted = undefined;
      },
      requestRender: () => undefined,
    };
    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }),
      hasOverlay: () => false,
    };
    const sessions = [
      {
        path: sessionPath,
        id: sessionId,
        cwd: root,
        created: new Date(),
        modified: new Date(),
        messageCount: 0,
      },
    ];
    const runtime = {
      getTab: () => undefined,
      listSessions: async () => sessions,
      listAllSessions: async () => sessions,
      extensionSwitchSession: async () => ({ cancelled: false }),
      createTab: async () => undefined,
      closeTab: async () => undefined,
    };
    await openSessionSelector(
      state,
      runtime as never,
      tui as never,
      "/repo",
      null,
      undefined,
      input,
    );
    await Bun.sleep(30);
    assert.ok(mounted, "selector must be mounted");

    const component = state.sessionSelector.component as InstanceType<
      typeof SessionSelectorComponent
    >;
    assert.ok(component);
    await component.getSessionList().onDeleteSession(sessionPath);

    const trashInvocations = trashCalls.filter((args) => args[0] === "trash").length;
    assert.equal(
      trashInvocations,
      1,
      `one UI delete must run \`trash\` exactly once, got ${trashInvocations}:\n${JSON.stringify(trashCalls)}`,
    );
    assert.equal(fs.existsSync(sessionPath), false, "session file must be removed");
  } finally {
    childProcess.spawnSync = originalNodeSpawnSync;
    (Bun as unknown as { spawnSync: unknown }).spawnSync = originalBunSpawnSync;
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
