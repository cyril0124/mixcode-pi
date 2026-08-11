import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";

import { parseMainArgs } from "../src/cli/main.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import {
  cleanupInstanceRegistry,
  createInstanceSnapshot,
  DEFAULT_INSTANCE_STALE_AFTER_MS,
  formatInstanceStatusTable,
  instanceRegistryDir,
  loadLiveInstanceStatus,
  writeInstanceSnapshot,
  type InstanceRegistrySnapshot,
  type ProcessIdentity,
} from "../src/core/instance-registry.js";

function snapshot(overrides: Partial<InstanceRegistrySnapshot>): InstanceRegistrySnapshot {
  return {
    version: 1,
    pid: 100,
    processStartTime: "start-100",
    processVerification: "linux-start-time",
    workdir: "/repo",
    activeTabId: "s1",
    updatedAt: "2026-06-06T00:00:10.000Z",
    tabs: [
      {
        index: 1,
        sessionId: "s1-abcdef123456",
        title: "Agent-01",
        workdir: "/repo",
        status: "idle",
        unreadDone: false,
        pendingDialogCount: 0,
        pendingUserInteractionCount: 0,
      },
    ],
    ...overrides,
  };
}

const liveProcesses = new Map<number, ProcessIdentity>([
  [100, { alive: true, startTime: "start-100", verification: "linux-start-time" }],
  [101, { alive: true, startTime: "start-101", verification: "linux-start-time" }],
  [102, { alive: false, verification: "linux-start-time" }],
  [103, { alive: true, startTime: "different-start", verification: "linux-start-time" }],
  [104, { alive: true, startTime: "start-104", verification: "linux-start-time" }],
]);

const processInfo = (pid: number): ProcessIdentity =>
  liveProcesses.get(pid) ?? { alive: false, verification: "linux-start-time" };

test("parseMainArgs parses status subcommand without launching TUI args", () => {
  const args = parseMainArgs(["status", "--json", "--workdir", "repo"], "/home/user");
  assert.equal(args.command, "status");
  assert.equal(args.json, true);
  assert.equal(args.statusWorkdir, "/home/user/repo");
  assert.equal(args.workdir, "/home/user");
  assert.throws(() => parseMainArgs(["status", "--batch", "x.lua"], "/home/user"), /Unknown status argument/);
  assert.throws(() => parseMainArgs(["--workdir", "/repo", "status"], "/home/user"), /Unknown argument/);
});

test("createInstanceSnapshot captures live tab metadata without chat content", () => {
  const state = createInitialState("/repo/");
  const tab = createTab(1, "session-full-id", "/repo", {
    title: "Worker",
    status: "thinking",
    unreadDone: true,
    workingStartedAt: "2026-06-06T00:00:00.000Z",
  });
  tab.pendingDialogs.push({
    requestId: "q1",
    sessionId: tab.sessionId,
    questions: [],
    currentQuestionIndex: 0,
    highlightedOptionIndices: [],
    selectedAnswers: [],
    customAnswers: [],
    dirty: false,
  });
  tab.extensionUi.pendingUserInteractions.push({ id: "u1", kind: "custom" });
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;

  const captured = createInstanceSnapshot(state, {
    now: new Date("2026-06-06T00:00:12.000Z"),
    pid: 123,
    processIdentity: { alive: true, startTime: "start-123", verification: "linux-start-time" },
  });

  assert.equal(captured.workdir, "/repo");
  assert.equal(captured.activeTabId, "session-full-id");
  assert.equal(captured.tabs[0]?.title, "Worker");
  assert.equal(captured.tabs[0]?.pendingDialogCount, 1);
  assert.equal(captured.tabs[0]?.pendingUserInteractionCount, 1);
  assert.equal(JSON.stringify(captured).includes("questions"), false);
});

test("loadLiveInstanceStatus filters stale dead and pid-reused snapshots", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-"));
  try {
    await writeInstanceSnapshot(root, snapshot({ pid: 100, workdir: "/b-repo" }));
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
        processStartTime: "start-101",
        workdir: "/a-repo",
        updatedAt: "2026-06-05T23:59:00.000Z",
      }),
    );
    await writeInstanceSnapshot(root, snapshot({ pid: 102, processStartTime: undefined }));
    await writeInstanceSnapshot(root, snapshot({ pid: 103, processStartTime: "old-start" }));
    await writeInstanceSnapshot(root, snapshot({ pid: 104, processStartTime: undefined }));
    await fsPromises.mkdir(instanceRegistryDir(root), { recursive: true });
    await fsPromises.writeFile(path.join(instanceRegistryDir(root), "999.json"), "not-json", "utf8");

    const result = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
      staleAfterMs: DEFAULT_INSTANCE_STALE_AFTER_MS,
    });

    assert.equal(result.instances.length, 1);
    assert.equal(result.instances[0]?.pid, 100);
    assert.equal(result.instances[0]?.workdir, "/b-repo");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]?.message ?? "", /JSON|Unexpected|invalid/i);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("loadLiveInstanceStatus derives tab state and sorts instances by workdir", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-state-"));
  try {
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 100,
        workdir: "/z-repo",
        activeTabId: "config",
        tabs: [
          {
            index: 1,
            sessionId: "needs-input-session",
            title: "Needs Input",
            workdir: "/z-repo",
            status: "done",
            unreadDone: true,
            pendingDialogCount: 1,
            pendingUserInteractionCount: 0,
            lastWorkedDurationSeconds: 3,
          },
          {
            index: 2,
            sessionId: "running-session",
            title: "Running",
            workdir: "/z-repo",
            status: "running",
            unreadDone: false,
            pendingDialogCount: 0,
            pendingUserInteractionCount: 0,
            workingStartedAt: "2026-06-06T00:00:00.000Z",
          },
          {
            index: 3,
            sessionId: "finished-session",
            title: "Finished",
            workdir: "/z-repo",
            status: "idle",
            unreadDone: true,
            pendingDialogCount: 0,
            pendingUserInteractionCount: 0,
            lastWorkedDurationSeconds: 7,
          },
        ],
      }),
    );
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
        processStartTime: "start-101",
        workdir: "/a-repo",
        activeTabId: "s2",
        tabs: [
          {
            index: 1,
            sessionId: "s2",
            title: "Idle",
            workdir: "/a-repo",
            status: "idle",
            unreadDone: false,
            pendingDialogCount: 0,
            pendingUserInteractionCount: 0,
          },
        ],
      }),
    );

    const result = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    assert.deepEqual(
      result.instances.map((instance) => instance.workdir),
      ["/a-repo", "/z-repo"],
    );
    const zRepo = result.instances[1]!;
    assert.equal(zRepo.activeLabel, "<config>");
    assert.deepEqual(
      zRepo.tabs.map((tab) => [tab.title, tab.state, tab.status, tab.elapsedSeconds]),
      [
        ["Needs Input", "needs-input", "done", 3],
        ["Running", "working", "running", 12],
        ["Finished", "finished", "idle", 7],
      ],
    );
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("formatInstanceStatusTable renders grouped instances and active tabs", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-format-"));
  try {
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
        processStartTime: "start-101",
        workdir: "/repo",
        activeTabId: "active-session-abcdef",
        tabs: [
          {
            index: 1,
            sessionId: "active-session-abcdef",
            title: "Active Worker",
            workdir: "/repo",
            status: "thinking",
            unreadDone: false,
            pendingDialogCount: 0,
            pendingUserInteractionCount: 0,
            workingStartedAt: "2026-06-06T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    const table = formatInstanceStatusTable(result);
    assert.match(table, /PID 101/);
    assert.match(table, /workdir: \/repo/);
    assert.match(table, /active=active-session/);
    assert.match(table, /TITLE\s+SESSION/);
    assert.match(table, /\*\s+working\s+thinking\s+12s\s+Active Worker\s+active-session-abcdef/);
    assert.equal(formatInstanceStatusTable({ ...result, instances: [] }), "No live mpi instances.");
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("cleanupInstanceRegistry removes stale dead and reused-pid snapshots", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-clean-"));
  try {
    await writeInstanceSnapshot(root, snapshot({ pid: 100 }));
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
        processStartTime: "start-101",
        updatedAt: "2026-06-05T23:59:00.000Z",
      }),
    );
    await writeInstanceSnapshot(root, snapshot({ pid: 102, processStartTime: undefined }));
    await writeInstanceSnapshot(root, snapshot({ pid: 103, processStartTime: "old-start" }));
    await writeInstanceSnapshot(root, snapshot({ pid: 104, processStartTime: undefined }));

    const result = await cleanupInstanceRegistry(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    assert.deepEqual(result.removed.sort(), [101, 102, 103, 104]);
    const live = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });
    assert.deepEqual(live.instances.map((instance) => instance.pid), [100]);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("loadLiveInstanceStatus ignores atomic-write temp files beside snapshots", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-tmp-"));
  try {
    await writeInstanceSnapshot(root, snapshot({ pid: 100 }));
    // Leftover / in-flight writeInstanceSnapshot temps must not trip directory listing.
    await fsPromises.writeFile(
      path.join(instanceRegistryDir(root), "100.json.100.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp"),
      "{incomplete\n",
      "utf8",
    );
    await fsPromises.writeFile(
      path.join(instanceRegistryDir(root), "999.json.999.ffffffff-0000-1111-2222-333333333333.tmp"),
      "",
      "utf8",
    );
    const result = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });
    assert.deepEqual(result.instances.map((instance) => instance.pid), [100]);
    assert.equal(result.warnings.length, 0);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
