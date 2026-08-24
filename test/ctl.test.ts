import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import {
  ctlClientTimeoutMs,
  isCtlCliArgs,
  parseCtlArgs,
  resolveSendPromptText,
  requestCtl,
  selectCtlInstance,
  shouldTruncateCtlOutput,
  normalizeCtlStdout,
  truncateCtlStdout,
} from "../src/cli/ctl.js";
import {
  CTL_MESSAGE_DIVIDER,
  formatCtlTime,
  handleCtlRequest,
  IMPLIED_FOCUS_REASON,
  mpiCtlSkillPath,
  resolveCtlDumpWidths,
  startInstanceCtlServer,
  wrapCtlSubmitText,
} from "../src/core/instance-ctl-server.js";
import { instanceRegistryDir, writeInstanceSnapshot } from "../src/core/instance-registry.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { InjectingTerminal } from "../src/ui/terminal.js";
import type { Terminal } from "@earendil-works/pi-tui";

test("isCtlCliArgs detects ctl subcommand", () => {
  assert.equal(isCtlCliArgs(["ctl"]), true);
  assert.equal(isCtlCliArgs(["ctl", "last-assistant-message"]), true);
  assert.equal(isCtlCliArgs(["status"]), false);
  assert.equal(isCtlCliArgs([]), false);
});

test("parseCtlArgs parses target flags and send-keys tokens", () => {
  const last = parseCtlArgs(["last-assistant-message"], "/caller");
  assert.equal(last.op, "last-assistant-message");
  assert.equal(last.workdir, undefined);

  const dump = parseCtlArgs(["--pid", "12", "--focus-session", "s1", "dump-screen"], "/caller");
  assert.equal(dump.op, "dump-screen");
  assert.equal(dump.pid, 12);
  assert.equal(dump.focusSessionId, "s1");

  const byTitle = parseCtlArgs(["--focus-tab", "Agent-01", "last-assistant-message"], "/caller");
  assert.equal(byTitle.focusTabTitle, "Agent-01");

  const keys = parseCtlArgs(["--workdir", "./rel", "send-keys", "C-p"], "/caller");
  assert.equal(keys.op, "send-keys");
  assert.equal(keys.workdir, path.resolve("/caller", "./rel"));
  assert.deepEqual(keys.keys, ["\x10"]);

  const literal = parseCtlArgs(["send-keys", "--literal", "Enter"], "/caller");
  assert.deepEqual(literal.keys, ["Enter"]);
  assert.deepEqual(parseCtlArgs(["send-keys", "/compact", "Enter"], "/caller").keys, [
    "/compact",
    "\r",
  ]);

  assert.equal(parseCtlArgs(["--help"], "/caller").help, true);
  assert.throws(
    () => parseCtlArgs(["--pid", "12", "--workdir", "/repo", "last-assistant-message"], "/caller"),
    /--pid and --workdir are mutually exclusive/,
  );
  assert.throws(
    () => parseCtlArgs(["--focus-tab", "A", "--focus-session", "s1", "last-assistant-message"], "/caller"),
    /mutually exclusive/,
  );
  const byTab = parseCtlArgs(["--tab", "Agent-01", "last-message"], "/caller");
  assert.equal(byTab.tabTitle, "Agent-01");
  assert.equal(parseCtlArgs(["--session", "home", "dump-screen"], "/caller").sessionId, "home");
  assert.throws(
    () => parseCtlArgs(["--tab", "A", "--focus-tab", "B", "last-message"], "/caller"),
    /mutually exclusive/,
  );
  assert.equal(parseCtlArgs(["dump-screen"], "/caller").ansi, false);
  assert.equal(parseCtlArgs(["dump-screen", "--ansi"], "/caller").ansi, true);
  assert.equal(parseCtlArgs(["dump-screen", "--width", "120"], "/caller").width, 120);
  assert.throws(() => parseCtlArgs(["wait", "--width", "80"], "/caller"), /only applies to dump-screen/);
  assert.equal(parseCtlArgs(["send-prompt", "--expect-response", "hi"], "/caller").expectResponse, true);
  assert.throws(
    () => parseCtlArgs(["wait", "--expect-response"], "/caller"),
    /only applies to send-prompt/,
  );
  assert.deepEqual(resolveCtlDumpWidths(undefined, 40), { dumpWidth: 40, overlayWidth: 100 });
  assert.deepEqual(resolveCtlDumpWidths(60, 40), { dumpWidth: 60, overlayWidth: 60 });
  const waitDefault = parseCtlArgs(["wait"], "/caller");
  assert.equal(waitDefault.op, "wait");
  assert.equal(ctlClientTimeoutMs({ op: "last-message" }), 10_000);
  assert.equal(ctlClientTimeoutMs({ op: "send-keys" }), 10_000);
  assert.equal(ctlClientTimeoutMs({ op: "wait" }), 65_000);
  assert.equal(ctlClientTimeoutMs({ op: "wait", timeout: 180 }), 185_000);
  assert.equal(ctlClientTimeoutMs({ op: "wait", timeout: 0 }), 5_000);
  assert.equal(waitDefault.timeout, 60);
  const waitArgs = parseCtlArgs(["wait", "--timeout", "5"], "/caller");
  assert.equal(waitArgs.op, "wait");
  assert.equal(waitArgs.timeout, 5);
  const toolArgs = parseCtlArgs(["last-tool", "--from", "1", "--to", "2"], "/caller");
  assert.equal(toolArgs.op, "last-tool");
  assert.throws(() => parseCtlArgs(["dump-screen", "--timeout", "1"], "/caller"), /only applies to wait/);
  const mixed = parseCtlArgs(["last-message", "--from", "1", "--to", "2"], "/caller");
  assert.equal(mixed.op, "last-message");
  assert.equal(mixed.from, 1);
  assert.equal(mixed.to, 2);
  const range = parseCtlArgs(["last-assistant-message", "--from", "1", "--to", "3"], "/caller");
  assert.equal(range.from, 1);
  assert.equal(range.to, 3);
  assert.throws(() => parseCtlArgs(["last-assistant-message", "--from", "2"], "/caller"), /must be used together/);
  assert.throws(() => parseCtlArgs(["last-assistant-message", "--from", "3", "--to", "1"], "/caller"), /cannot be greater/);
  assert.throws(() => parseCtlArgs(["dump-screen", "--from", "1", "--to", "2"], "/caller"), /only apply/);
  assert.throws(() => parseCtlArgs(["nope"], "/caller"), /Unknown ctl command/);
  assert.throws(() => parseCtlArgs(["--pid"], "/caller"), /--pid requires a number/);
  assert.throws(() => parseCtlArgs(["dump-screen", "-l"], "/caller"), /--literal only applies/);
  assert.throws(() => parseCtlArgs(["last-message", "--ansi"], "/caller"), /--ansi only applies/);
});

test("selectCtlInstance targets MIXCODE_PID before cwd workdir", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-ctl-envpid-"));
  const other = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
  const snapshot = (pid: number, workdir: string) =>
    writeInstanceSnapshot(root, {
      version: 1,
      pid,
      workdir,
      activeTabId: "s1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tabs: [],
    });
  try {
    await snapshot(process.pid, "/repo-cwd");
    await snapshot(other.pid, "/repo-env");
    const picked = await selectCtlInstance(
      { op: "last-assistant-message" },
      { stateDir: root, env: { MIXCODE_PID: String(other.pid) } },
    );
    assert.equal(picked.pid, other.pid);
    // Explicit --workdir beats the env pid.
    const byWorkdir = await selectCtlInstance(
      { op: "last-assistant-message", workdir: "/repo-cwd" },
      { stateDir: root, env: { MIXCODE_PID: String(other.pid) } },
    );
    assert.equal(byWorkdir.pid, process.pid);
    // Stale env pid surfaces a targeted error instead of silently retargeting cwd.
    await assert.rejects(
      selectCtlInstance({ op: "last-assistant-message" }, { stateDir: root, env: { MIXCODE_PID: "999999" } }),
      /MIXCODE_PID=999999/,
    );
    await assert.rejects(
      selectCtlInstance({ op: "last-assistant-message" }, { stateDir: root, env: { MIXCODE_PID: "42junk" } }),
      /Invalid MIXCODE_PID/,
    );
  } finally {
    other.kill();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("selectCtlInstance errors on zero or multiple matches", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-ctl-select-"));
  try {
    await assert.rejects(
      selectCtlInstance({ op: "last-assistant-message", workdir: "/none" }, { stateDir: root }),
      /No live mpi instance/,
    );
    await writeInstanceSnapshot(root, {
      version: 1,
      pid: process.pid,
      workdir: "/repo-a",
      activeTabId: "s1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tabs: [{ index: 0, sessionId: "s1", title: "Agent-01", workdir: "/repo-a", status: "idle", unreadDone: false, waitingForInputCount: 0 }],
    });
    const one = await selectCtlInstance({ op: "last-assistant-message", workdir: "/repo-a" }, { stateDir: root });
    assert.equal(one.pid, process.pid);
    const second = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      await writeInstanceSnapshot(root, {
        version: 1,
        pid: second.pid,
        workdir: "/repo-a",
        activeTabId: "home",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tabs: [{ index: 0, sessionId: "s1", title: "Worker", workdir: "/repo-a", status: "idle", unreadDone: false, waitingForInputCount: 0 }],
      });
      await assert.rejects(
        selectCtlInstance({ op: "last-assistant-message", workdir: "/repo-a" }, { stateDir: root }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return (
            message.startsWith("Multiple live mpi instances match this workdir; pass --pid <n>:") &&
            message.includes(`  ${process.pid}  tabs: 1  active: Agent-01`) &&
            message.includes(`  ${second.pid}  tabs: 1  active: home`) &&
            message.includes("MIXCODE_PID")
          );
        },
      );
    } finally {
      second.kill();
    }
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

function stubTerminal(): Terminal {
  return {
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}

test("InjectingTerminal forwards start callback to inject", () => {
  const seen: string[] = [];
  const injecting = new InjectingTerminal(stubTerminal());
  assert.throws(() => injecting.inject("x"), /before the TUI starts/);
  injecting.start((data) => seen.push(data), () => undefined);
  injecting.inject("\x10");
  assert.deepEqual(seen, ["\x10"]);
});

test("handleCtlRequest wait and dump-screen see MixCode app overlays", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.activeTabId = "s1";
  const opts = {
    state,
    runtime: { getTab: () => ({ chat: [] }) } as unknown as MixCodeRuntime,
    injectInput: () => undefined,
    hasAppOverlay: () => true,
    renderAppOverlay: () => ["Close Session", "[Y] Close    [N] Cancel"],
  };
  const wait = await handleCtlRequest({ op: "wait", timeout: 0 }, opts);
  assert.equal(wait.ok, true);
  assert.match(wait.text ?? "", /status: wait-for-input/);
  const screen = await handleCtlRequest({ op: "dump-screen" }, opts);
  assert.match(screen.text ?? "", /Close Session/);
  assert.match(screen.text ?? "", /\[Y\] Close/);
  const idle = await handleCtlRequest(
    { op: "wait", timeout: 0 },
    { ...opts, hasAppOverlay: () => false, renderAppOverlay: () => [] },
  );
  assert.match(idle.text ?? "", /status: finished/);
});

test("handleCtlRequest last-assistant-message send-keys and dump-screen", async () => {
  const injected: string[] = [];
  const submitted: { sessionId: string; text: string }[] = [];
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.tabs.push(createTab(2, "s2", "/repo", { title: "gif" }));
  state.activeTabId = "s2";
  const runtime = {
    getTab: (sessionId: string) =>
      sessionId === "s1"
        ? {
            chat: [
              { role: "user", text: "hi", timestamp: 1_700_000_000_000 },
              { role: "assistant", text: "hello from agent" },
              {
                role: "tool",
                title: "bash",
                status: "success",
                text: "pong",
                args: { command: "echo pong" },
              },
            ],
          }
        : sessionId === "s2"
          ? {
              chat: [
                { role: "assistant", text: "older" },
                { role: "assistant", text: "from gif" },
              ],
              extensionCustomOverlayComponents: new Set([
                {
                  render: (width: number) => [`Ask User Question w=${width}`, "  [x] yes"],
                },
              ]),
            }
          : undefined,
  } as unknown as MixCodeRuntime;
  const opts = {
    state,
    runtime,
    injectInput: (data: string) => injected.push(data),
    submitToTab: (tab: { sessionId: string }, text: string) => {
      submitted.push({ sessionId: tab.sessionId, text });
    },
    screenWidth: () => 80,
  };
  const reply = await handleCtlRequest({ op: "last-assistant-message" }, opts);
  assert.equal(reply.ok, true);
  assert.equal(
    reply.text,
    `tab: gif\nsession: s2\nreason: ${IMPLIED_FOCUS_REASON}\n\n${CTL_MESSAGE_DIVIDER}\ntime: unknown\nfrom gif\n`,
  );
  const keys = await handleCtlRequest({ op: "send-keys", keys: ["/compact", "\r"] }, opts);
  assert.equal(keys.ok, true);
  assert.deepEqual(injected, ["/compact", "\r"]);
  assert.equal(keys.text, `tab: gif\nsession: s2\nreason: ${IMPLIED_FOCUS_REASON}\n\n`);
  const screen = await handleCtlRequest({ op: "dump-screen" }, { ...opts, screenWidth: () => 40 });
  assert.equal(screen.ok, true);
  assert.match(screen.text ?? "", /^tab: gif\nsession: s2\nreason:/);
  assert.match(screen.text ?? "", /from gif/);
  assert.match(screen.text ?? "", /Ask User Question w=100/);
  assert.match(screen.text ?? "", /\[x\] yes/);
  const wide = await handleCtlRequest({ op: "dump-screen", width: 60 }, { ...opts, screenWidth: () => 40 });
  assert.match(wide.text ?? "", /Ask User Question w=60/);
  const liveOpts = {
    ...opts,
    screenWidth: () => 40,
    renderTui: () => ["LIVE TUI"],
  };
  const live = await handleCtlRequest({ op: "dump-screen" }, liveOpts);
  assert.match(live.text ?? "", /LIVE TUI/);
  const byTab = await handleCtlRequest({ op: "dump-screen", tabTitle: "gif" }, liveOpts);
  assert.doesNotMatch(byTab.text ?? "", /LIVE TUI/);
  assert.match(byTab.text ?? "", /from gif/);
  assert.match(byTab.text ?? "", /Ask User Question w=100/);
  const peek = await handleCtlRequest({ op: "last-assistant-message", tabTitle: "Agent-01" }, opts);
  assert.equal(peek.ok, true);
  assert.match(peek.text ?? "", /hello from agent/);
  assert.equal(state.activeTabId, "s2");
  const draftKeys = await handleCtlRequest(
    { op: "send-keys", tabTitle: "Agent-01", keys: ["draft"] },
    opts,
  );
  assert.equal(draftKeys.ok, true);
  assert.equal(state.tabs.find((tab) => tab.sessionId === "s1")?.draftInput, "draft");
  assert.deepEqual(injected, ["/compact", "\r"]);
  const submitKeys = await handleCtlRequest(
    { op: "send-keys", tabTitle: "Agent-01", keys: ["hello", "\r"] },
    opts,
  );
  assert.equal(submitKeys.ok, true);
  await Promise.resolve();
  assert.deepEqual(submitted, [{ sessionId: "s1", text: "hello" }]);
  assert.equal(state.activeTabId, "s2");
  let hangingResolved = false;
  const hanging = Promise.withResolvers<void>();
  const hangingOpts = {
    ...opts,
    submitToTab: async () => {
      await hanging.promise;
      hangingResolved = true;
    },
  };
  const acked = await handleCtlRequest(
    { op: "send-keys", tabTitle: "Agent-01", keys: ["later", "\r"] },
    hangingOpts,
  );
  assert.equal(acked.ok, true);
  assert.equal(hangingResolved, false);
  hanging.resolve();
  await hanging.promise;
  const uiKeys = await handleCtlRequest(
    { op: "send-keys", tabTitle: "Agent-01", keys: ["\x1b[B"] },
    opts,
  );
  assert.equal(uiKeys.ok, false);
  assert.match(uiKeys.error ?? "", /only supports text and Enter/);
  const missing = await handleCtlRequest({ op: "last-assistant-message", focusSessionId: "nope" }, opts);
  assert.equal(missing.ok, false);
  assert.equal(missing.text, undefined);
  assert.match(missing.error ?? "", /Unknown session/);
  const byTitle = await handleCtlRequest({ op: "last-assistant-message", focusTabTitle: "Agent-01" }, opts);
  assert.equal(byTitle.ok, true);
  assert.equal(
    byTitle.text,
    `tab: Agent-01\nsession: s1\n\n${CTL_MESSAGE_DIVIDER}\ntime: unknown\nhello from agent\n`,
  );
  assert.equal(state.activeTabId, "s1");
  const mixedLast = await handleCtlRequest({ op: "last-message" }, opts);
  assert.equal(mixedLast.ok, true);
  assert.equal(
    mixedLast.text,
    `tab: Agent-01\nsession: s1\nreason: ${IMPLIED_FOCUS_REASON}\n\n${CTL_MESSAGE_DIVIDER}\nrole: assistant\ntime: unknown\nhello from agent\n`,
  );
  const mixedRange = await handleCtlRequest({ op: "last-message", from: 1, to: 2 }, opts);
  assert.equal(mixedRange.ok, true);
  assert.equal(
    mixedRange.text,
    `tab: Agent-01\nsession: s1\nreason: ${IMPLIED_FOCUS_REASON}\n\n${CTL_MESSAGE_DIVIDER}\nrole: user\ntime: ${formatCtlTime(1_700_000_000_000)}\nhi\n${CTL_MESSAGE_DIVIDER}\nrole: assistant\ntime: unknown\nhello from agent\n`,
  );
  const tool = await handleCtlRequest({ op: "last-tool" }, opts);
  assert.equal(tool.ok, true);
  assert.equal(
    tool.text,
    `tab: Agent-01\nsession: s1\nreason: ${IMPLIED_FOCUS_REASON}\n\n${CTL_MESSAGE_DIVIDER}\ntool: bash\nstatus: success\ncommand: echo pong\ntime: unknown\npong\n`,
  );
  const waitIdle = await handleCtlRequest({ op: "wait", timeout: 0 }, opts);
  assert.equal(waitIdle.ok, true);
  assert.equal(
    waitIdle.text,
    `tab: Agent-01\nsession: s1\nreason: ${IMPLIED_FOCUS_REASON}\n\nstatus: finished\ntimeout: 0\n`,
  );
  const running = state.tabs.find((tab) => tab.sessionId === "s1");
  if (!running) throw new Error("expected s1");
  running.status = "running";
  const waitBusy = await handleCtlRequest({ op: "wait", timeout: 0 }, opts);
  assert.equal(waitBusy.ok, false);
  assert.match(waitBusy.error ?? "", /Timed out after 0s/);
  assert.match(waitBusy.text ?? "", /status: running/);
  running.extensionUi.waitingForInputs.push({ id: "q1", kind: "custom" });
  const waitInput = await handleCtlRequest({ op: "wait", timeout: 0 }, opts);
  assert.equal(waitInput.ok, true);
  assert.match(waitInput.text ?? "", /status: wait-for-input/);
  running.extensionUi.waitingForInputs = [];
  setTimeout(() => {
    running.status = "idle";
  }, 20);
  const waitFlip = await handleCtlRequest({ op: "wait", timeout: 1 }, opts);
  assert.equal(waitFlip.ok, true);
  assert.match(waitFlip.text ?? "", /status: finished/);
  const user = await handleCtlRequest({ op: "last-user-message" }, opts);
  assert.equal(user.ok, true);
  assert.equal(
    user.text,
    `tab: Agent-01\nsession: s1\nreason: ${IMPLIED_FOCUS_REASON}\n\n${CTL_MESSAGE_DIVIDER}\ntime: ${formatCtlTime(1_700_000_000_000)}\nhi\n`,
  );
  const ranged = await handleCtlRequest({ op: "last-assistant-message", from: 1, to: 3 }, opts);
  assert.equal(ranged.ok, true);
  assert.equal(
    ranged.text,
    `tab: Agent-01\nsession: s1\nreason: ${IMPLIED_FOCUS_REASON}\nmessages: 1 (requested 1-3)\n\n${CTL_MESSAGE_DIVIDER}\ntime: unknown\nhello from agent\n`,
  );
  const badRange = await handleCtlRequest({ op: "last-assistant-message", from: 0, to: 2 }, opts);
  assert.equal(badRange.ok, false);
  assert.match(badRange.error ?? "", /Invalid message range/);
  state.activeTabId = "s2";
  const lastTwo = await handleCtlRequest({ op: "last-assistant-message", from: 1, to: 2 }, opts);
  assert.equal(lastTwo.ok, true);
  assert.equal(
    lastTwo.text,
    `tab: gif\nsession: s2\nreason: ${IMPLIED_FOCUS_REASON}\n\n${CTL_MESSAGE_DIVIDER}\ntime: unknown\nolder\n${CTL_MESSAGE_DIVIDER}\ntime: unknown\nfrom gif\n`,
  );
  const emptyRange = await handleCtlRequest({ op: "last-assistant-message", from: 4, to: 5 }, opts);
  assert.equal(emptyRange.ok, true);
  assert.equal(
    emptyRange.text,
    `tab: gif\nsession: s2\nreason: ${IMPLIED_FOCUS_REASON}\nmessages: 0 (requested 4-5)\n\n`,
  );
  const loading = state.tabs.find((tab) => tab.sessionId === "s2");
  if (!loading) throw new Error("expected s2");
  loading.status = "Not Ready";
  const notReady = await handleCtlRequest({ op: "last-assistant-message" }, opts);
  assert.equal(notReady.ok, false);
  assert.equal(notReady.text, undefined);
  assert.match(notReady.error ?? "", /still loading extensions/);
  const readySibling = await handleCtlRequest(
    { op: "last-assistant-message", tabTitle: "Agent-01" },
    opts,
  );
  assert.equal(readySibling.ok, true);
  assert.match(readySibling.text ?? "", /hello from agent/);
  const waitSibling = await handleCtlRequest(
    { op: "wait", tabTitle: "Agent-01", timeout: 0 },
    opts,
  );
  assert.equal(waitSibling.ok, true);
  assert.match(waitSibling.text ?? "", /status: finished/);
  const promptSibling = await handleCtlRequest(
    { op: "send-prompt", tabTitle: "Agent-01", prompt: "hi" },
    opts,
  );
  assert.equal(promptSibling.ok, true);
  state.activeTabId = "home";
  const homeWhileLoading = await handleCtlRequest({ op: "dump-screen" }, opts);
  assert.equal(homeWhileLoading.ok, true);
  assert.match(homeWhileLoading.text ?? "", /^tab: home\nsession: home\nreason:/);
  loading.status = "idle";
  state.activeTabId = "home";
  const home = await handleCtlRequest({ op: "last-assistant-message" }, opts);
  assert.equal(home.ok, false);
  assert.equal(home.text, `tab: home\nsession: home\nreason: ${IMPLIED_FOCUS_REASON}\n\n`);
  assert.match(home.error ?? "", /Home has no assistant message/);
});

test("ctl socket server answers a client request", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-ctl-sock-"));
  const injected: string[] = [];
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.activeTabId = "s1";
  const server = startInstanceCtlServer({
    rootStateDir: root,
    pid: process.pid,
    state,
    runtime: {
      getTab: () => ({ chat: [{ role: "assistant", text: "pong" }] }),
    } as unknown as MixCodeRuntime,
    injectInput: (data) => injected.push(data),
  });
  try {
    for (let i = 0; i < 20 && !(await Bun.file(server.socketPath).exists()); i++) {
      await Bun.sleep(10);
    }
    assert.equal((await fsPromises.stat(server.socketPath)).mode & 0o777, 0o600);
    const reply = await requestCtl(server.socketPath, { op: "last-assistant-message" });
    assert.equal(reply.ok, true);
    assert.match(reply.text ?? "", /tab: Agent-01\nsession: s1\nreason:/);
    assert.match(reply.text ?? "", /----------\ntime: unknown\npong\n$/);
    const sent = await requestCtl(server.socketPath, { op: "send-keys", keys: ["z"] });
    assert.equal(sent.ok, true);
    assert.deepEqual(injected, ["z"]);
  } finally {
    server.dispose();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("ctl socket server reports async bind failure via onError and keeps running", async () => {
  // Contract: a bind failure must reach onError instead of crashing the
  // process through an unhandled 'error' event, and dispose() stays safe even
  // though the server never listened. A read-only instances dir passes the
  // sync fs prep (mkdir no-op, rm ENOENT) but makes bind fail (EACCES), which
  // Bun reports asynchronously after listen() returns.
  const base = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-ctl-err-"));
  const dir = instanceRegistryDir(base);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.chmod(dir, 0o500);
  const state = createInitialState("/repo");
  const errors: Error[] = [];
  const server = startInstanceCtlServer({
    rootStateDir: base,
    pid: process.pid,
    state,
    runtime: { getTab: () => ({ chat: [] }) } as unknown as MixCodeRuntime,
    injectInput: () => undefined,
    onError: (error) => errors.push(error),
  });
  try {
    for (let i = 0; i < 100 && errors.length === 0; i++) {
      await Bun.sleep(10);
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /listen|bind|EACCES/i);
  } finally {
    server.dispose();
    await fsPromises.chmod(dir, 0o700);
    await fsPromises.rm(base, { recursive: true, force: true });
  }
});

test("startInstanceCtlServer surfaces sync fs failures to the caller", async () => {
  // Contract: sync prep failures (mkdir/rm on the registry dir) must throw to
  // the caller so the TUI can show a notice — never be swallowed silently.
  const base = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-ctl-sync-"));
  const root = path.join(base, "state");
  await fsPromises.writeFile(root, "not a dir");
  const state = createInitialState("/repo");
  try {
    assert.throws(
      () =>
        startInstanceCtlServer({
          rootStateDir: root,
          pid: process.pid,
          state,
          runtime: { getTab: () => ({ chat: [] }) } as unknown as MixCodeRuntime,
          injectInput: () => undefined,
        }),
      /ENOTDIR|EEXIST|ENOENT/,
    );
  } finally {
    await fsPromises.rm(base, { recursive: true, force: true });
  }
});

test("parseCtlArgs and handleCtlRequest send-prompt", async () => {
  const parsed = parseCtlArgs(["send-prompt", "hello\nworld"], "/caller");
  assert.equal(parsed.op, "send-prompt");
  assert.equal(parsed.prompt, "hello\nworld");
  assert.equal(parsed.promptFromStdin, false);
  assert.equal(parseCtlArgs(["send-prompt", "a", "b"], "/caller").prompt, "a b");
  const heredoc = parseCtlArgs(["send-prompt"], "/caller");
  assert.equal(heredoc.promptFromStdin, true);
  assert.equal(parseCtlArgs(["send-prompt", "-"], "/caller").promptFromStdin, true);
  assert.equal(
    await resolveSendPromptText({ prompt: "hi" }),
    "hi",
  );
  assert.equal(
    await resolveSendPromptText({ promptFromStdin: true }, { isTTY: false, readStdin: async () => "line1\nline2\n" }),
    "line1\nline2\n",
  );
  await assert.rejects(
    resolveSendPromptText({ promptFromStdin: true }, { isTTY: true }),
    /heredoc\/pipe/,
  );
  assert.equal(shouldTruncateCtlOutput("send-prompt"), false);

  const submitted: string[] = [];
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.activeTabId = "s1";
  const opts = {
    state,
    runtime: { getTab: () => ({ chat: [] }) } as unknown as MixCodeRuntime,
    injectInput: () => undefined,
    submitToTab: (_tab: { sessionId: string }, text: string) => {
      submitted.push(text);
    },
    screenWidth: () => 80,
  };
  const origin01 =
    "This prompt came from another MixCode tab (Agent-01) via `mpi ctl`, not from the human user.";
  const originSender =
    "This prompt came from another MixCode tab (Sender) via `mpi ctl`, not from the human user.";
  assert.equal(wrapCtlSubmitText("hello", "Agent-01"), `${origin01}\n\nhello`);
  assert.equal(wrapCtlSubmitText("hello"), "hello");
  assert.equal(wrapCtlSubmitText("/compact", "Agent-01"), "/compact");
  assert.equal(wrapCtlSubmitText("!ls"), "!ls");
  assert.equal(wrapCtlSubmitText("!!ls"), "!!ls");
  const skillPath = mpiCtlSkillPath();
  assert.match(skillPath, /\/extensions\/mpi-ctl\/skills\/mpi-ctl\/SKILL\.md$/);
  assert.equal(path.isAbsolute(skillPath), true);
  const expectedReply = wrapCtlSubmitText("hello", "Agent-01", true);
  assert.match(expectedReply, /^This prompt came from another MixCode tab \(Agent-01\) via `mpi ctl`/);
  assert.ok(expectedReply.includes(`When finished, follow the mpi-ctl skill at:\n${skillPath}\n`));
  assert.ok(expectedReply.includes("Send your result back with `mpi ctl`:"));
  assert.ok(expectedReply.includes("mpi ctl --tab 'Agent-01' send-prompt <<'EOF'"));
  assert.match(expectedReply, /Do not pass --expect-response on that reply\.\n\nhello$/);
  assert.throws(() => wrapCtlSubmitText("hello", undefined, true), /MIXCODE_TAB_TITLE/);
  assert.throws(() => wrapCtlSubmitText("/compact", "Agent-01", true), /does not apply to \/ or !/);
  const withPid = wrapCtlSubmitText("hello", "Agent-01", false, 4242);
  assert.equal(
    withPid,
    "This prompt came from another MixCode tab (Agent-01, pid 4242) via `mpi ctl`, not from the human user.\n\nhello",
  );
  const expectedReplyPid = wrapCtlSubmitText("hello", "Agent-01", true, 4242);
  assert.match(expectedReplyPid, /\(Agent-01, pid 4242\) via `mpi ctl`/);
  assert.ok(expectedReplyPid.includes("mpi ctl --pid 4242 --tab 'Agent-01' send-prompt <<'EOF'"));

  const sent = await handleCtlRequest(
    { op: "send-prompt", tabTitle: "Agent-01", prompt: "hello\nworld", fromTabTitle: "Sender", fromPid: 4242 },
    opts,
  );
  assert.equal(sent.ok, true);
  assert.equal(submitted[0], wrapCtlSubmitText("hello\nworld", "Sender", false, 4242));
  submitted.length = 0;
  const slash = await handleCtlRequest(
    { op: "send-prompt", tabTitle: "Agent-01", prompt: "/compact", fromTabTitle: "Sender" },
    opts,
  );
  assert.equal(slash.ok, true);
  assert.deepEqual(submitted, ["/compact"]);
  submitted.length = 0;
  const keyedSlash = await handleCtlRequest(
    { op: "send-keys", tabTitle: "Agent-01", keys: ["/compact", "\r"], fromTabTitle: "Sender" },
    opts,
  );
  assert.equal(keyedSlash.ok, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(submitted, ["/compact"]);
  submitted.length = 0;
  const keyed = await handleCtlRequest(
    { op: "send-keys", tabTitle: "Agent-01", keys: ["hi", "\r"], fromTabTitle: "Sender" },
    opts,
  );
  assert.equal(keyed.ok, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(submitted, [`${originSender}\n\nhi`]);
  submitted.length = 0;
  const expectReply = await handleCtlRequest(
    {
      op: "send-prompt",
      tabTitle: "Agent-01",
      prompt: "review",
      fromTabTitle: "Sender",
      expectResponse: true,
    },
    opts,
  );
  assert.equal(expectReply.ok, true);
  assert.equal(submitted[0], wrapCtlSubmitText("review", "Sender", true));
  submitted.length = 0;
  const expectSlash = await handleCtlRequest(
    {
      op: "send-prompt",
      tabTitle: "Agent-01",
      prompt: "/compact",
      fromTabTitle: "Sender",
      expectResponse: true,
    },
    opts,
  );
  assert.equal(expectSlash.ok, false);
  assert.match(expectSlash.error ?? "", /does not apply to \/ or !/);
  assert.equal(state.activeTabId, "s1");
});

test("wait stays busy until fire-and-forget send-prompt settles", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Agent-01" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const gate = Promise.withResolvers<void>();
  const opts = {
    state,
    runtime: { getTab: () => ({ chat: [] }) } as unknown as MixCodeRuntime,
    injectInput: () => undefined,
    submitToTab: async () => {
      await gate.promise;
    },
  };
  const sent = await handleCtlRequest(
    { op: "send-prompt", tabTitle: "Agent-01", prompt: "hello" },
    opts,
  );
  assert.equal(sent.ok, true);
  const once = await handleCtlRequest({ op: "wait", tabTitle: "Agent-01", timeout: 0 }, opts);
  assert.equal(once.ok, false);
  assert.match(once.text ?? "", /status: running/);
  const waiting = handleCtlRequest({ op: "wait", tabTitle: "Agent-01", timeout: 1 }, opts);
  gate.resolve();
  const done = await waiting;
  assert.equal(done.ok, true);
  assert.match(done.text ?? "", /status: finished/);
});

test("truncateCtlStdout leaves short output unchanged and dumps long output to tmp", async () => {
  assert.equal(shouldTruncateCtlOutput("send-keys"), false);
  assert.equal(shouldTruncateCtlOutput("wait"), false);
  assert.equal(shouldTruncateCtlOutput("dump-screen"), true);
  assert.equal(shouldTruncateCtlOutput("last-tool"), true);
  assert.equal(normalizeCtlStdout("\x1b[31mred\x1b[39m   \nplain  "), "red\nplain");
  assert.equal(normalizeCtlStdout("keep  \x1b[0m  ", true), "keep  \x1b[0m");
  assert.equal(shouldTruncateCtlOutput("last-assistant-message"), true);

  const short = await truncateCtlStdout("hello", {
    op: "dump-screen",
    pid: 1,
    tmpDir: os.tmpdir(),
  });
  assert.equal(short.text, "hello");
  assert.equal(short.overflowPath, undefined);

  const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-ctl-trunc-"));
  try {
    const full = `\u4e2d${"x".repeat(9000)}`;
    const long = await truncateCtlStdout(full, {
      op: "last-user-message",
      pid: 99,
      tmpDir: tmp,
      now: 123,
    });
    assert.ok(long.overflowPath?.endsWith("mpi-ctl-99-last-user-message-123.txt"));
    assert.equal(await Bun.file(long.overflowPath!).text(), full);
    const st = await fsPromises.stat(long.overflowPath!);
    assert.equal(st.mode & 0o777, 0o600);
    assert.match(
      long.text,
      /\[Full output: .*mpi-ctl-99-last-user-message-123\.txt\. Truncated: showing last \d+ lines \(4\.0KB tail limit\)\]/,
    );
    assert.ok(!long.text.includes("\u4e2d"), "preview must not split the leading CJK code point when taking tail");
    const preview = long.text.split("\n\n")[1]!;
    assert.ok(Buffer.byteLength(preview, "utf8") <= 4096);
  } finally {
    await fsPromises.rm(tmp, { recursive: true, force: true });
  }
});

test("ctl send-prompt reports a failed slash command on the target tab", async () => {
  // ACK is sent before the submit settles, so a throwing slash command has no
  // ctl response channel left; the tab surface is the only place `dump-screen`
  // can still see it.
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Agent-01" }));
  state.activeTabId = "s1";
  const appended: Array<{ sessionId: string; message: string; kind?: string }> = [];
  let renders = 0;
  const response = await handleCtlRequest(
    { op: "send-prompt", tabTitle: "Agent-01", prompt: "/models bogus" },
    {
      state,
      runtime: {
        getTab: () => ({ chat: [] }),
        appendSystemMessage: (sessionId: string, message: string, kind?: string) => {
          appended.push({ sessionId, message, kind });
        },
      } as unknown as MixCodeRuntime,
      injectInput: () => undefined,
      submitToTab: async () => {
        throw new Error("Error: Unknown model: bogus");
      },
      requestRender: () => {
        renders += 1;
      },
      screenWidth: () => 80,
    },
  );

  assert.equal(response.ok, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(appended, [
    { sessionId: "s1", message: "Error: Unknown model: bogus", kind: "error" },
  ]);
  assert.equal(renders > 0, true);
});
