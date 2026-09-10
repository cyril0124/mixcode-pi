import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type MessageRenderer,
  SessionManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import bashExtension, { type DetachedExitDetails, killTree } from "./index.js";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type Notice = Parameters<ExtensionAPI["sendMessage"]>[0];
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function harness(stallSeconds = 0.1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-bash-notice-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldForeground = process.env.MPI_BASH_FOREGROUND_SECONDS;
  const oldStall = process.env.MPI_BASH_STALL_SECONDS;
  process.env.MPI_BASH_FOREGROUND_SECONDS = "0.05";
  process.env.MPI_BASH_STALL_SECONDS = String(stallSeconds);
  cleanups.push(() => {
    if (oldForeground === undefined) delete process.env.MPI_BASH_FOREGROUND_SECONDS;
    else process.env.MPI_BASH_FOREGROUND_SECONDS = oldForeground;
    if (oldStall === undefined) delete process.env.MPI_BASH_STALL_SECONDS;
    else process.env.MPI_BASH_STALL_SECONDS = oldStall;
  });
  const handlers = new Map<string, Handler>();
  const renderers = new Map<string, MessageRenderer>();
  const listeners = new Set<(notice: Notice) => void>();
  let bash: ToolDefinition | undefined;
  let started = false;
  let idle = false;
  const notices: Notice[] = [];
  const nextNotice = (matches: (notice: Notice) => boolean): Promise<Notice> => {
    const existing = notices.find(matches);
    if (existing) return Promise.resolve(existing);
    const pending = Promise.withResolvers<Notice>();
    const listener = (notice: Notice) => {
      if (!matches(notice)) return;
      listeners.delete(listener);
      pending.resolve(notice);
    };
    listeners.add(listener);
    return pending.promise;
  };
  const errors: string[] = [];
  const exit = Promise.withResolvers<void>();
  const stall = Promise.withResolvers<void>();
  const ctx = {
    cwd: dir,
    sessionManager: SessionManager.inMemory(dir),
    isIdle: () => idle,
    ui: { setWidget: () => {}, notify: (text: string) => errors.push(text) },
  } as unknown as ExtensionContext;
  // Pi host stub for driving session events and collecting deliveries.
  bashExtension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: ToolDefinition) => {
      bash = tool;
    },
    registerCommand: () => {},
    registerMessageRenderer: (type: string, renderer: MessageRenderer) => {
      renderers.set(type, renderer);
    },
    sendMessage: (notice: Notice) => {
      notices.push(notice);
      for (const listener of listeners) listener(notice);
      if (notice.customType === "bash-detached-exit") {
        const details = notice.details as DetachedExitDetails;
        cleanups.push(() => fs.rmSync(details.logPath, { force: true }));
        exit.resolve();
      }
      if (notice.customType === "bash-detached-stall") stall.resolve();
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string) => handlers.get(name)?.({} as never, ctx);
  cleanups.push(() => {
    emit("session_shutdown");
  });
  return {
    notices,
    errors,
    exit: exit.promise,
    stall: stall.promise,
    setIdle: (value: boolean) => {
      idle = value;
    },
    emit,
    render(notice: Notice, width = 100): string[] {
      return (
        renderers
          .get(notice.customType)?.(
            { ...notice, role: "custom", timestamp: Date.now() },
            { expanded: false, outputPad: 1 },
            plainTheme,
          )
          ?.render(width) ?? []
      );
    },
    async start(command: string) {
      if (!started) {
        await emit("session_start");
        started = true;
      }
      assert.ok(bash);
      return bash.execute("job", { command, timeout: 10 }, undefined, undefined, ctx);
    },
    async startGated(name: string, exitCode = 0, writesOutput = false) {
      const gate = path.join(dir, `${name}.done`);
      const output = writesOutput ? "printf 'working\\n'; " : "";
      const result = await this.start(
        `while [ ! -f '${gate}' ]; do ${output}sleep 0.02; done; exit ${exitCode}`,
      );
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const pid = Number(/\(pid (\d+)\)/.exec(text)?.[1]);
      const logPath = /(\/\S*mpi-bash-[\w-]+\.log)/.exec(text)?.[1];
      assert.ok(pid && logPath, `expected a detached job: ${text}`);
      let finished = false;
      const completion = nextNotice(
        (notice) =>
          notice.customType === "bash-detached-exit" &&
          (notice.details as DetachedExitDetails).logPath === logPath,
      ).then((notice) => {
        finished = true;
        return notice;
      });
      cleanups.push(() => {
        if (!finished) killTree(pid);
        fs.rmSync(logPath, { force: true });
      });
      return {
        pid,
        text,
        logPath,
        async complete() {
          fs.writeFileSync(gate, "done");
          return completion;
        },
      };
    },
  };
}

test("notifications retain session running PID snapshots as jobs finish", async () => {
  const foreignHost = harness(0);
  const foreign = await foreignHost.startGated("foreign");
  const host = harness(0);
  const first = await host.startGated("first", 2);
  const second = await host.startGated("second");
  try {
    assert.match(first.text, new RegExp(`Still running: 1 job · PIDs: ${first.pid}\\b`));
    assert.match(
      second.text,
      new RegExp(`Still running: 2 jobs · PIDs: ${first.pid}, ${second.pid}\\b`),
    );
    assert.ok(!second.text.includes(String(foreign.pid)), "another session's jobs are excluded");

    const firstNotice = await first.complete();
    const remaining = `Still running: 1 job · PIDs: ${second.pid}`;
    assert.ok(String(firstNotice.content).includes(remaining));
    assert.match(String(firstNotice.content), /outcome="failure"/);
    assert.match(host.render(firstNotice).join("\n"), new RegExp(`PID ${first.pid}\\b`));
    assert.ok(host.render(firstNotice).join("\n").includes(remaining));

    // Persist/reload after all jobs end: a historical notice must keep its send-time snapshot.
    const saved = JSON.parse(JSON.stringify(firstNotice)) as Notice;
    const finalNotice = await second.complete();
    assert.match(String(finalNotice.content), /Still running: 0 jobs/);
    assert.match(host.render(finalNotice).join("\n"), /Still running: 0 jobs/);
    assert.ok(host.render(saved).join("\n").includes(remaining));
    assert.deepEqual(host.errors, []);
  } finally {
    await Promise.all([first.complete(), second.complete(), foreign.complete()]);
  }
});

test("one stall batch includes every running PID and renders its snapshot once", async () => {
  const host = harness();
  const first = await host.startGated("silent-first");
  const second = await host.startGated("silent-second");
  const active = await host.startGated("active", 0, true);
  try {
    host.setIdle(true);
    await host.stall;
    host.setIdle(false);
    const notice = host.notices.find((entry) => entry.customType === "bash-detached-stall");
    assert.ok(notice);
    const remaining = `Still running: 3 jobs · PIDs: ${first.pid}, ${second.pid}, ${active.pid}`;
    assert.ok(String(notice.content).includes(remaining));
    assert.equal(String(notice.content).match(/<bash_stall /g)?.length, 2);
    const screen = host.render(notice).join("\n");
    assert.match(screen, new RegExp(`PID ${first.pid}\\b`));
    assert.match(screen, new RegExp(`PID ${second.pid}\\b`));
    assert.ok(screen.includes(remaining));
    assert.equal(screen.match(/Still running:/g)?.length, 1);

    for (const width of [30, 48, 80]) {
      const lines = host.render(notice, width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const wrapped = lines.join(" ").replace(/\s+/g, " ");
      for (const pid of [first.pid, second.pid, active.pid]) {
        assert.ok(wrapped.includes(String(pid)), `PID ${pid} disappeared at width ${width}`);
      }
    }
    const saved = JSON.parse(JSON.stringify(notice)) as Notice;
    await Promise.all([first.complete(), second.complete(), active.complete()]);
    assert.ok(host.render(saved).join("\n").includes(remaining));
    assert.deepEqual(host.errors, []);
  } finally {
    host.setIdle(false);
    await Promise.all([first.complete(), second.complete(), active.complete()]);
  }
});

test("stored notices without running snapshots do not invent a count", () => {
  const host = harness(0);
  const completion = host
    .render({
      customType: "bash-detached-exit",
      content: "",
      display: true,
      details: {
        command: "true",
        exitCode: 0,
        timedOut: false,
        tail: "",
        lineCount: 0,
        elapsedMs: 1000,
        logPath: "/tmp/old.log",
      },
    })
    .join("\n");
  assert.match(completion, /Background job finished/);
  assert.doesNotMatch(completion, /Still running:|PID undefined/);
  const stall = host
    .render({
      customType: "bash-detached-stall",
      content: "",
      display: true,
      details: [{ id: 42, command: "sleep 60", silenceMs: 1000, elapsedMs: 2000, tail: "" }],
    })
    .join("\n");
  assert.match(stall, /Background job stalled/);
  assert.doesNotMatch(stall, /Still running:/);
});

test("a busy session never queues a stall for a command that finishes before settlement", async () => {
  const host = harness();
  await host.start("sleep 1.2; printf 'done\\n'");
  await host.exit;
  host.setIdle(true);
  await host.emit("agent_settled");
  assert.deepEqual(host.errors, []);
  assert.deepEqual(
    host.notices.map((notice) => notice.customType),
    ["bash-detached-exit"],
  );
});

test("settlement checks a pending silent job without waiting for another timer tick", async () => {
  const host = harness();
  await host.start("sleep 1.5; printf 'done\\n'");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(host.notices.length, 0);
  host.setIdle(true);
  await host.emit("agent_settled");
  assert.equal(host.notices[0]?.customType, "bash-detached-stall");
  await host.exit;
  assert.deepEqual(host.errors, []);
});

test("settlement discards the old silence when command output has resumed", async () => {
  const host = harness(0.6);
  await host.start("sleep 1.2; printf 'resumed\\n'; sleep 0.6");
  await new Promise((resolve) => setTimeout(resolve, 1250));
  host.setIdle(true);
  await host.emit("agent_settled");
  assert.equal(host.notices.length, 0);
  host.setIdle(false);
  await host.exit;
  assert.deepEqual(
    host.notices.map((notice) => notice.customType),
    ["bash-detached-exit"],
  );
  assert.deepEqual(host.errors, []);
});

test("an idle session is still notified of a genuinely silent command", async () => {
  const host = harness();
  host.setIdle(true);
  await host.start("sleep 1.2; printf 'done\\n'");
  await host.stall;
  assert.equal(host.notices[0]?.customType, "bash-detached-stall");
  await host.exit;
  assert.deepEqual(host.errors, []);
});
