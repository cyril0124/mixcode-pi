import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import herdrReportExtension from "./index.js";

type Report = {
  id: string;
  method: string;
  params: { state?: string; agent_session_id?: string; seq: number };
};
async function createSession(
  cwd: string,
  id: string,
  mode: ExtensionContext["mode"] = "tui",
  reloadModule = false,
) {
  let idle = true;
  const ctx = {
    mode,
    sessionManager: { getSessionId: () => id },
    isIdle: () => idle,
  } as ExtensionContext;
  const agentDir = path.join(cwd, "agent");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [herdrReportExtension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  if (!reloadModule) await loader.reload();
  const result = reloadModule
    ? await discoverAndLoadExtensions([path.join(import.meta.dirname, "index.ts")], cwd, agentDir)
    : loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extension = result.extensions[0];
  assert.ok(extension, "extension must load successfully");
  return {
    setIdle(value: boolean) {
      idle = value;
    },
    async emit(event: string) {
      if (event === "agent_start") idle = false;
      if (event === "agent_settled") idle = true;
      for (const handler of extension.handlers.get(event) ?? []) {
        await handler({ reason: "startup" }, ctx);
      }
    },
  };
}

async function withReporter(
  run: (reports: Report[], cwd: string, closed: Map<string, number>) => Promise<void>,
  respond: (report: Report) => Record<string, unknown> = () => ({ result: { type: "ok" } }),
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-herdr-lifecycle-"));
  const env = {
    MIXCODE: "1",
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: path.join(dir, "herdr.sock"),
    HERDR_PANE_ID: "w1:p1",
    // Match compiled mpi's uncached module loading.
    JITI_TRY_NATIVE: "false",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const reports: Report[] = [];
  const closed = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let requestId: string | undefined;
    socket.on("close", () => {
      sockets.delete(socket);
      if (requestId) closed.set(requestId, (closed.get(requestId) ?? 0) + 1);
    });
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const report = JSON.parse(buffer.slice(0, end)) as Report;
      reports.push(report);
      requestId = report.id;
      socket.end(`${JSON.stringify({ id: report.id, ...respond(report) })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(env.HERDR_SOCKET_PATH, resolve));
  Object.assign(process.env, env);
  try {
    await run(reports, dir, closed);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), `expected report was not received within ${timeoutMs} ms`);
}

function latestState(reports: Report[]): string | undefined {
  return reports.findLast((report) => report.method === "pane.report_agent")?.params.state;
}

test("alternating tabs report working again after another tab reports idle", async () => {
  await withReporter(async (reports, cwd) => {
    const a = await createSession(cwd, "a");
    const b = await createSession(cwd, "b");
    try {
      await a.emit("session_start");
      await b.emit("session_start");
      await waitFor(() => latestState(reports) === "idle");
      await a.emit("agent_start");
      await waitFor(() => latestState(reports) === "working");
      await b.emit("agent_start");
      await waitFor(
        () => reports.filter((r) => r.method === "pane.report_agent_session").length === 4,
      );
      await a.emit("agent_settled");
      await b.emit("agent_settled");
      await waitFor(() => latestState(reports) === "idle");
      await a.emit("agent_start");
      await waitFor(() => latestState(reports) === "working");
    } finally {
      await a.emit("session_shutdown");
      await b.emit("session_shutdown");
    }
  });
});

test("reloading the extension preserves another tab's busy state", async () => {
  await withReporter(async (reports, cwd) => {
    const a = await createSession(cwd, "a");
    const b = await createSession(cwd, "b", "tui", true);
    try {
      await a.emit("session_start");
      await waitFor(() => latestState(reports) === "idle");
      await a.emit("agent_start");
      await waitFor(() => latestState(reports) === "working");
      const before = reports.filter((r) => r.method === "pane.report_agent").length;
      await b.emit("session_start");
      await waitFor(() => reports.filter((r) => r.method === "pane.report_agent").length > before);
      assert.equal(latestState(reports), "working");
      await b.emit("session_shutdown");
      await a.emit("agent_settled");
      await waitFor(() => latestState(reports) === "idle");
    } finally {
      await b.emit("session_shutdown");
      await a.emit("session_shutdown");
    }
  });
});

test("a failed working report can be retried by another busy tab", async () => {
  const rejected: string[] = [];
  let rejectWorking = true;
  let acceptedState: string | undefined;
  await withReporter(
    async (reports, cwd, closed) => {
      const a = await createSession(cwd, "a");
      const b = await createSession(cwd, "b");
      try {
        await a.emit("session_start");
        await waitFor(() => acceptedState === "idle");
        await b.emit("session_start");
        await waitFor(() => reports.filter((r) => r.method === "pane.report_agent").length === 2);
        await a.emit("agent_start");
        await waitFor(() => {
          const id = rejected[0];
          return rejected.length === 2 && id !== undefined && closed.get(id) === 2;
        });
        rejectWorking = false;
        await b.emit("agent_start");
        await waitFor(() => acceptedState === "working");
      } finally {
        rejectWorking = false;
        await a.emit("session_shutdown");
        await b.emit("session_shutdown");
      }
    },
    (report) => {
      if (report.method === "pane.report_agent") {
        if (rejectWorking && report.params.state === "working") {
          rejected.push(report.id);
          return { error: { code: "busy", message: "Try again" } };
        }
        acceptedState = report.params.state;
      }
      return { result: { type: "ok" } };
    },
  );
});

test("idle runtimes sharing a session cannot erase another runtime's work", async () => {
  await withReporter(async (reports, cwd) => {
    const a = await createSession(cwd, "same-session");
    const b = await createSession(cwd, "same-session");
    try {
      await a.emit("session_start");
      await waitFor(() => latestState(reports) === "idle");
      await a.emit("agent_start");
      await waitFor(() => latestState(reports) === "working");
      const before = reports.filter((r) => r.method === "pane.report_agent").length;
      await b.emit("session_start");
      await waitFor(() => reports.filter((r) => r.method === "pane.report_agent").length > before);
      assert.equal(latestState(reports), "working");
      await b.emit("session_shutdown");
      await a.emit("agent_settled");
      await waitFor(() => latestState(reports) === "idle");
    } finally {
      await b.emit("session_shutdown");
      await a.emit("session_shutdown");
    }
  });
});

test("busy and idle changes without agent events are reconciled", async () => {
  await withReporter(async (reports, cwd) => {
    const session = await createSession(cwd, "compacting");
    try {
      await session.emit("session_start");
      await waitFor(() => latestState(reports) === "idle");
      session.setIdle(false);
      await waitFor(() => latestState(reports) === "working", 3500);
      session.setIdle(true);
      await waitFor(() => latestState(reports) === "idle", 3500);
    } finally {
      await session.emit("session_shutdown");
    }
  });
});

test("busy state recovers after a later-sequenced external idle report", async () => {
  let highestSeq = 0;
  let remoteState: string | undefined;
  await withReporter(
    async (_reports, cwd) => {
      const session = await createSession(cwd, "busy");
      try {
        await session.emit("session_start");
        await waitFor(() => remoteState === "idle");
        await session.emit("agent_start");
        await waitFor(() => remoteState === "working");
        // Herdr acknowledges stale sequences without applying their state.
        highestSeq = Math.max(highestSeq + 1, Date.now() * 1000);
        remoteState = "idle";
        await waitFor(() => remoteState === "working", 3500);
      } finally {
        await session.emit("session_shutdown");
      }
    },
    (report) => {
      if (report.method === "pane.report_agent" && report.params.seq > highestSeq) {
        highestSeq = report.params.seq;
        remoteState = report.params.state;
      }
      return { result: { type: "ok" } };
    },
  );
});

test("closing the last TUI session stops periodic publication", async () => {
  await withReporter(async (reports, cwd) => {
    const session = await createSession(cwd, "closing");
    try {
      await session.emit("session_start");
      await waitFor(() => latestState(reports) === "idle");
      await session.emit("session_shutdown");
      const before = reports.length;
      await new Promise((resolve) => setTimeout(resolve, 2300));
      assert.equal(reports.length, before, "closed sessions must not keep reporting");
    } finally {
      await session.emit("session_shutdown");
    }
  });
});

test("a non-TUI shutdown cannot clear a running TUI session", async () => {
  await withReporter(async (reports, cwd) => {
    const root = await createSession(cwd, "root");
    const child = await createSession(cwd, "child", "print");
    try {
      await root.emit("session_start");
      await waitFor(() => latestState(reports) === "idle");
      await root.emit("agent_start");
      await waitFor(() => latestState(reports) === "working");
      await child.emit("session_start");
      await child.emit("session_shutdown");
      assert.equal(latestState(reports), "working");
    } finally {
      await root.emit("session_shutdown");
    }
  });
});
