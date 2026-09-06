import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import bashExtension from "./index.js";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type Notice = { customType: string; details?: { logPath?: string } };
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
  let bash: ToolDefinition | undefined;
  let idle = false;
  const notices: Notice[] = [];
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
    registerMessageRenderer: () => {},
    sendMessage: (notice: Notice) => {
      notices.push(notice);
      if (notice.customType === "bash-detached-exit") {
        if (notice.details?.logPath)
          cleanups.push(() => fs.rmSync(notice.details!.logPath!, { force: true }));
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
    async start(command: string) {
      await emit("session_start");
      assert.ok(bash);
      await bash.execute("job", { command, timeout: 10 }, undefined, undefined, ctx);
    },
  };
}

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
