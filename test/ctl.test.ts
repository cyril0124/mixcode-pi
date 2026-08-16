import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import {
  isCtlCliArgs,
  parseCtlArgs,
  requestCtl,
  selectCtlInstance,
  shouldTruncateCtlOutput,
  normalizeCtlStdout,
  stripCtlAnsi,
  truncateCtlStdout,
} from "../src/cli/ctl.js";
import {
  CTL_MESSAGE_DIVIDER,
  formatCtlTime,
  handleCtlRequest,
  IMPLIED_FOCUS_REASON,
  startInstanceCtlServer,
} from "../src/core/instance-ctl-server.js";
import { writeInstanceSnapshot } from "../src/core/instance-registry.js";
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
    /--focus-tab and --focus-session are mutually exclusive/,
  );
  assert.equal(parseCtlArgs(["dump-screen"], "/caller").ansi, false);
  assert.equal(parseCtlArgs(["dump-screen", "--ansi"], "/caller").ansi, true);
  const waitDefault = parseCtlArgs(["wait"], "/caller");
  assert.equal(waitDefault.op, "wait");
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
      processVerification: "pid-only",
      workdir,
      activeTabId: "s1",
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
      processVerification: "pid-only",
      workdir: "/repo-a",
      activeTabId: "s1",
      updatedAt: new Date().toISOString(),
      tabs: [],
    });
    const one = await selectCtlInstance({ op: "last-assistant-message", workdir: "/repo-a" }, { stateDir: root });
    assert.equal(one.pid, process.pid);
    const second = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      await writeInstanceSnapshot(root, {
        version: 1,
        pid: second.pid,
        processVerification: "pid-only",
        workdir: "/repo-a",
        activeTabId: "s1",
        updatedAt: new Date().toISOString(),
        tabs: [],
      });
      await assert.rejects(
        selectCtlInstance({ op: "last-assistant-message", workdir: "/repo-a" }, { stateDir: root }),
        /Multiple live mpi instances match/,
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

test("handleCtlRequest last-assistant-message send-keys and dump-screen", async () => {
  const injected: string[] = [];
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
            }
          : undefined,
  } as unknown as MixCodeRuntime;
  const opts = {
    state,
    runtime,
    injectInput: (data: string) => injected.push(data),
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
  const screen = await handleCtlRequest({ op: "dump-screen" }, opts);
  assert.equal(screen.ok, true);
  assert.match(screen.text ?? "", /^tab: gif\nsession: s2\nreason:/);
  assert.match(screen.text ?? "", /from gif/);
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
  running.pendingDialogs.push({
    requestId: "q1",
    sessionId: "s1",
    questions: [],
    multiple: false,
    custom: false,
    currentQuestionIndex: 0,
    highlightedOptionIndices: [],
    selectedAnswers: [],
    customAnswers: [],
    dirty: false,
  });
  const waitInput = await handleCtlRequest({ op: "wait", timeout: 0 }, opts);
  assert.equal(waitInput.ok, true);
  assert.match(waitInput.text ?? "", /status: wait-for-input/);
  running.pendingDialogs = [];
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
  state.activeTabId = "home";
  const homeWhileLoading = await handleCtlRequest({ op: "dump-screen" }, opts);
  assert.equal(homeWhileLoading.ok, false);
  assert.match(homeWhileLoading.error ?? "", /still loading extensions/);
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

test("truncateCtlStdout leaves short output unchanged and dumps long output to tmp", async () => {
  assert.equal(shouldTruncateCtlOutput("send-keys"), false);
  assert.equal(shouldTruncateCtlOutput("wait"), false);
  assert.equal(shouldTruncateCtlOutput("dump-screen"), true);
  assert.equal(shouldTruncateCtlOutput("last-tool"), true);
  assert.equal(stripCtlAnsi("\x1b[31mred\x1b[39m"), "red");
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
    const full = `${"x".repeat(9000)}\u4e2d`;
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
    assert.match(long.text, /\[truncated\] full output: /);
    assert.match(long.text, /\(\d+ bytes\)/);
    assert.ok(!long.text.includes("\u4e2d"), "preview must not split the trailing CJK code point");
    const preview = long.text.split("\n\n[truncated]")[0]!;
    assert.ok(Buffer.byteLength(preview, "utf8") <= 4096);
  } finally {
    await fsPromises.rm(tmp, { recursive: true, force: true });
  }
});
