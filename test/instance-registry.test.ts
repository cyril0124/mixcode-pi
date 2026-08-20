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
  formatDisplayWorkdir,
  formatInstanceStatusJson,
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
    workdir: "/repo",
    activeTabId: "s1",
    createdAt: "2026-06-05T23:00:00.000Z",
    updatedAt: "2026-06-06T00:00:10.000Z",
    tabs: [
      {
        index: 1,
        sessionId: "s1-abcdef123456",
        title: "Agent-01",
        workdir: "/repo",
        status: "idle",
        unreadDone: false,
        waitingForInputCount: 0,
      },
    ],
    ...overrides,
  };
}

const liveProcesses = new Map<number, ProcessIdentity>([
  [100, { alive: true }],
  [101, { alive: true }],
  [102, { alive: false }],
]);

const processInfo = (pid: number): ProcessIdentity =>
  liveProcesses.get(pid) ?? { alive: false };

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
  tab.extensionUi.waitingForInputs.push({ id: "u1", kind: "custom" });
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;

  const captured = createInstanceSnapshot(state, {
    now: new Date("2026-06-06T00:00:12.000Z"),
    pid: 123,
    createdAt: "2026-06-05T23:00:00.000Z",
  });

  assert.equal(captured.workdir, "/repo");
  assert.equal(captured.activeTabId, "session-full-id");
  assert.equal(captured.createdAt, "2026-06-05T23:00:00.000Z");
  // Without an explicit value, createdAt defaults to this process's start time.
  const defaulted = createInstanceSnapshot(state);
  assert.equal(Number.isFinite(Date.parse(defaulted.createdAt)), true);
  assert.ok(Math.abs(Date.now() - Date.parse(defaulted.createdAt) - process.uptime() * 1000) < 5_000);
  assert.equal(captured.tabs[0]?.title, "Worker");
  assert.equal(captured.tabs[0]?.waitingForInputCount, 1);
  assert.equal(JSON.stringify(captured).includes("questions"), false);
});

test("loadLiveInstanceStatus filters stale and dead snapshots", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-"));
  try {
    await writeInstanceSnapshot(root, snapshot({ pid: 100, workdir: "/b-repo" }));
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
        workdir: "/a-repo",
        updatedAt: "2026-06-05T23:59:00.000Z",
      }),
    );
    await writeInstanceSnapshot(root, snapshot({ pid: 102 }));
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
        activeTabId: "home",
        tabs: [
          {
            index: 1,
            sessionId: "waiting-for-input-session",
            title: "Waiting For Input",
            workdir: "/z-repo",
            status: "done",
            unreadDone: true,
            waitingForInputCount: 1,
            lastWorkedDurationSeconds: 3,
          },
          {
            index: 2,
            sessionId: "running-session",
            title: "Running",
            workdir: "/z-repo",
            status: "running",
            unreadDone: false,
            waitingForInputCount: 0,
            workingStartedAt: "2026-06-06T00:00:00.000Z",
          },
          {
            index: 3,
            sessionId: "finished-session",
            title: "Finished",
            workdir: "/z-repo",
            status: "idle",
            unreadDone: true,
            waitingForInputCount: 0,
            lastWorkedDurationSeconds: 7,
          },
        ],
      }),
    );
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
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
            waitingForInputCount: 0,
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
    assert.equal(zRepo.activeTabId, "home");
    assert.deepEqual(
      zRepo.tabs.map((tab) => [tab.title, tab.state, tab.status]),
      [
        ["Waiting For Input", "waiting-for-input", "done"],
        ["Running", "working", "running"],
        ["Finished", "finished", "idle"],
      ],
    );
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("formatDisplayWorkdir contracts homedir prefix to tilde", () => {
  assert.equal(formatDisplayWorkdir("/home/user", "/home/user"), "~");
  assert.equal(formatDisplayWorkdir("/home/user/project", "/home/user"), "~/project");
  assert.equal(formatDisplayWorkdir("/home/user/workspace/repo", "/home/user"), "~/workspace/repo");
  assert.equal(formatDisplayWorkdir("/other/path", "/home/user"), "/other/path");
});

test("formatInstanceStatusTable renders grouped instances and active tabs", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-format-"));
  try {
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
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
            waitingForInputCount: 0,
            workingStartedAt: "2026-06-06T00:00:00.000Z",
          },
        ],
      }),
    );
    // Home-focused instance: no tab row carries "*"; focus shows in the header.
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 100,
        workdir: "/z-repo",
        activeTabId: "home",
        tabs: [
          {
            index: 1,
            sessionId: "home-focused-session",
            title: "Agent-02",
            workdir: "/z-repo",
            status: "idle",
            unreadDone: false,
            waitingForInputCount: 0,
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
    assert.match(table, /started: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(table, /PID 100 {2}workdir: \/z-repo {2}started: [^\n]* {2}focus: home/);
    assert.doesNotMatch(table, /\*\s+idle\s+idle\s+Agent-02/);
    assert.match(table, /TAB_TITLE\s+SESSION/);
    assert.match(table, /\*\s+working\s+thinking\s+Active Worker\s+active-session-abcdef/);
    assert.match(table, /\(\* = focused tab\)/);
    assert.equal(formatInstanceStatusTable({ ...result, instances: [] }), "No live mpi instances.");

    const json = JSON.parse(formatInstanceStatusJson(result));
    const tabFocused = json.instances.find((i: { pid: number }) => i.pid === 101);
    assert.equal(tabFocused.focus, "tab");
    assert.equal(tabFocused.activeTabTitle, "Active Worker");
    const homeFocused = json.instances.find((i: { pid: number }) => i.pid === 100);
    assert.equal(homeFocused.focus, "home");
    assert.equal(homeFocused.activeTabTitle, undefined);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("loadLiveInstanceStatus reports a warning for snapshots missing createdAt", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-create-"));
  try {
    const snapshotJson = { ...snapshot({ pid: 100 }) };
    delete (snapshotJson as Partial<InstanceRegistrySnapshot>).createdAt;
    await fsPromises.mkdir(instanceRegistryDir(root), { recursive: true });
    await fsPromises.writeFile(
      path.join(instanceRegistryDir(root), "100.json"),
      JSON.stringify(snapshotJson),
      "utf8",
    );

    const result = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    assert.equal(result.instances.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]?.message ?? "", /Invalid 'createdAt'/);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("a tab titled home stays distinguishable from the Home surface", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-home-tab-"));
  try {
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 100,
        activeTabId: "home-titled-session",
        tabs: [
          {
            index: 1,
            sessionId: "home-titled-session",
            title: "home",
            workdir: "/repo",
            status: "idle",
            unreadDone: false,
            waitingForInputCount: 0,
          },
        ],
      }),
    );
    const result = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    // The focused surface is a tab (row marker), never the Home header suffix.
    const table = formatInstanceStatusTable(result);
    assert.doesNotMatch(table, /focus: home/);
    assert.match(table, /\*\s+idle\s+idle\s+home\s+home-titled-session/);

    const json = JSON.parse(formatInstanceStatusJson(result));
    assert.equal(json.instances[0].focus, "tab");
    assert.equal(json.instances[0].activeTabTitle, "home");
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("cleanupInstanceRegistry removes stale and dead snapshots", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-clean-"));
  try {
    await writeInstanceSnapshot(root, snapshot({ pid: 100 }));
    await writeInstanceSnapshot(
      root,
      snapshot({
        pid: 101,
        updatedAt: "2026-06-05T23:59:00.000Z",
      }),
    );
    await writeInstanceSnapshot(root, snapshot({ pid: 102 }));

    const result = await cleanupInstanceRegistry(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    assert.deepEqual(result.removed.sort(), [101, 102]);
    const live = await loadLiveInstanceStatus(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });
    assert.deepEqual(live.instances.map((instance) => instance.pid), [100]);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("cleanupInstanceRegistry sweeps sockets and snapshot temps of dead pids only", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-sock-"));
  try {
    const dir = instanceRegistryDir(root);
    await fsPromises.mkdir(dir, { recursive: true });
    // Regular files stand in for socket nodes; cleanup matches by name + pid.
    await fsPromises.writeFile(path.join(dir, "100.sock"), "");
    await fsPromises.writeFile(path.join(dir, "102.sock"), "");
    await fsPromises.writeFile(
      path.join(dir, "100.json.100.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp"),
      "{incomplete\n",
    );
    await fsPromises.writeFile(
      path.join(dir, "102.json.102.ffffffff-0000-1111-2222-333333333333.tmp"),
      "",
    );

    const result = await cleanupInstanceRegistry(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    const remaining = (await fsPromises.readdir(dir)).sort();
    assert.deepEqual(remaining, [
      "100.json.100.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp",
      "100.sock",
    ]);
    assert.equal(result.removed.length, 0);
    assert.deepEqual(
      result.removedFiles.map((file) => path.basename(file)).sort(),
      ["102.json.102.ffffffff-0000-1111-2222-333333333333.tmp", "102.sock"],
    );
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("cleanupInstanceRegistry never touches another host's registry files", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-instance-registry-host-"));
  try {
    // Another cluster node sharing this NFS state dir writes under its own
    // hostname; its pids and sockets are meaningless on this host.
    const otherHostDir = path.join(root, "instances", "other-node");
    await fsPromises.mkdir(otherHostDir, { recursive: true });
    const staleJson = path.join(otherHostDir, "102.json");
    await fsPromises.writeFile(
      staleJson,
      JSON.stringify(snapshot({ pid: 102, updatedAt: "2020-01-01T00:00:00.000Z" })),
    );
    await fsPromises.writeFile(path.join(otherHostDir, "102.sock"), "");

    const result = await cleanupInstanceRegistry(root, {
      now: new Date("2026-06-06T00:00:12.000Z"),
      processInfo,
    });

    assert.deepEqual(result.removed, []);
    assert.deepEqual((await fsPromises.readdir(otherHostDir)).sort(), ["102.json", "102.sock"]);
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
