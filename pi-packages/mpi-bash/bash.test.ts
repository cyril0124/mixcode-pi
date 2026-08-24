import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import bashExtension, {
  appendBashTimeoutNote,
  backgroundRows,
  createDetachingBashOperations,
  formatCompletionNotice,
  formatRunChoice,
  type DetachedRun,
  type DetachedStart,
  pruneOldLogs,
  readLogForView,
  renderBackgroundWidget,
  resolveForegroundSeconds,
} from "./index.js";

/** The shape of pi's bash tool that these tests drive. */
type BashTool = {
  name: string;
  execute: (
    id: string,
    args: { command: string; timeout?: number },
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function collector() {
  const chunks: Buffer[] = [];
  return {
    onData: (data: Buffer) => {
      chunks.push(data);
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function operations(foregroundSeconds: number, onDetachedExit: (run: DetachedRun) => void = () => {}) {
  return createDetachingBashOperations({
    shellPath: undefined,
    foregroundSeconds,
    onDetachedExit,
  });
}

function detachNotice(text: string): string {
  return text.slice(text.indexOf("[mpi-bash]"));
}

test("/bash-logs lists this session's runs and opens the full log", async () => {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const notices: string[] = [];
  /** Completion notices the extension appends when a background run ends. */
  const exits: string[] = [];
  const selected: Array<{ title: string; options: string[] }> = [];
  const opened: Array<{ overlay: boolean; lines: string[] }> = [];
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  let bash: BashTool | undefined;

  type Overlay = { render(width: number): string[]; handleInput?(data: string): void };
  const ui = {
    setWidget: () => {},
    notify: (message: string) => notices.push(message),
    select: async (title: string, options: string[]) => {
      selected.push({ title, options });
      return options[0];
    },
    // Mirrors pi's ExtensionUIContext.custom: build the component, render it,
    // then let it close itself the way a user would.
    custom: async (
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (value: unknown) => void,
      ) => Overlay,
      options: { overlay?: boolean },
    ) => {
      const tui = { requestRender: () => {}, terminal: { rows: 30, columns: 100 } };
      let closed = false;
      const component = factory(tui, plainTheme, {}, () => {
        closed = true;
      });
      opened.push({ overlay: options.overlay === true, lines: component.render(80) });
      component.handleInput?.("q");
      assert.equal(closed, true, "the log overlay must close on q");
      return undefined;
    },
  };

  const previousWindow = process.env.MPI_BASH_FOREGROUND_SECONDS;
  process.env.MPI_BASH_FOREGROUND_SECONDS = "0.3";
  try {
    bashExtension({
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[event] ??= [];
        handlers[event].push(handler);
      },
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands[name] = options.handler;
      },
      registerTool: (tool: BashTool) => {
        bash = tool;
      },
      sendMessage: (message: { content: string }) => exits.push(message.content),
    } as never);

    const bashLogs = commands["bash-logs"];
    assert.ok(bashLogs, "the extension must register /bash-logs");

    // Nothing has run yet: the command must say so instead of opening a picker.
    await bashLogs("", { ui });
    assert.equal(selected.length, 0, "an empty history must not open a picker");
    assert.match(notices[0] ?? "", /No command has been sent to the background/);

    await handlers.session_start?.[0]?.({}, { cwd: process.cwd(), ui });
    const started = await bash?.execute("call-1", {
      command: 'printf "early\\n"; sleep 1; printf "late\\n"',
      timeout: 30,
    });
    // The detach notice is the only place with the absolute path: the pager
    // header shows the file name alone.
    const logPath = /(\/\S*mpi-bash-[\w-]+\.log)/.exec(started?.content[0]?.text ?? "")?.[1];
    assert.ok(logPath, `the detach notice must name the log: ${started?.content[0]?.text}`);

    // While it runs, the picker offers it as running.
    await bashLogs("", { ui });
    assert.match(selected[0]?.options[0] ?? "", /^● running +\d+s {2}printf "early/);

    // The log opens in a read-only pager: it carries the log's name and its own
    // scroll hints, and never pi's "enter submit" editor chrome.
    assert.equal(opened[0]?.overlay, true);
    const running = (opened[0]?.lines ?? []).join("\n");
    assert.match(running, /mpi-bash-[\w-]+\.log/);
    assert.match(running, /early/);
    assert.match(running, /q\/esc close/);

    await waitFor(() => exits[0]);

    // A finished run stays reachable, labelled with its exit code.
    await bashLogs("", { ui });
    assert.match(selected[1]?.options[0] ?? "", /^✓ exit 0 +\d+s {2}printf "early/);
    // The log carries both halves; the transcript stopped at the detach point.
    const finished = (opened[1]?.lines ?? []).join("\n");
    assert.match(finished, /early/);
    assert.match(finished, /late/);

    assert.match(finished, new RegExp(logPath.split("/").pop() ?? ""), "the pager must name the log");
    assert.equal(fs.readFileSync(logPath, "utf8"), "early\nlate\n");
    fs.rmSync(logPath, { force: true });
  } finally {
    if (previousWindow === undefined) delete process.env.MPI_BASH_FOREGROUND_SECONDS;
    else process.env.MPI_BASH_FOREGROUND_SECONDS = previousWindow;
  }
});

test("the log viewer caps what it reads and says how much it skipped", async () => {
  const logPath = path.join(os.tmpdir(), `mpi-bash-view-${process.pid}.log`);
  fs.writeFileSync(logPath, `${"a".repeat(500)}TAIL`);
  try {
    assert.equal(await readLogForView(logPath), `${"a".repeat(500)}TAIL`);

    const capped = await readLogForView(logPath, 100);
    assert.match(capped, /^\[mpi-bash\] Showing the last 100 of 504 bytes\./);
    assert.ok(capped.endsWith("TAIL"), "the cap must keep the end of the log, not the start");

    await assert.rejects(readLogForView(`${logPath}.missing`), /ENOENT/);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test("the pager follows a live log and leaves a finished one alone", async () => {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const tui = { requestRender: () => {}, terminal: { rows: 30, columns: 100 } };
  let bash: BashTool | undefined;
  /** The pager currently on screen; the fake overlay keeps it open. */
  let pager: { render(width: number): string[] } | undefined;

  const ui = {
    setWidget: () => {},
    notify: () => {},
    select: async (_title: string, options: string[]) => options[0],
    custom: async (
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (value: unknown) => void,
      ) => { render(width: number): string[] },
    ) => {
      // Stays open, as it does for a reader watching a command run.
      pager = factory(tui, plainTheme, {}, () => {});
      return new Promise<void>(() => {});
    },
  };
  const screen = () => (pager?.render(80) ?? []).join("\n");

  const previousWindow = process.env.MPI_BASH_FOREGROUND_SECONDS;
  process.env.MPI_BASH_FOREGROUND_SECONDS = "0.3";
  try {
    bashExtension({
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[event] ??= [];
        handlers[event].push(handler);
      },
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands[name] = options.handler;
      },
      registerTool: (tool: BashTool) => {
        bash = tool;
      },
      sendMessage: () => {},
    } as never);
    await handlers.session_start?.[0]?.({}, { cwd: process.cwd(), ui });

    const started = await bash?.execute("call-1", {
      command: 'printf "first\\n"; sleep 2; printf "second\\n"',
      timeout: 30,
    });
    const logPath = /(\/\S*mpi-bash-[\w-]+\.log)/.exec(started?.content[0]?.text ?? "")?.[1];
    assert.ok(logPath, `the detach notice must name the log: ${started?.content[0]?.text}`);

    void commands["bash-logs"]?.("", { ui });
    await waitFor(() => (screen().includes("first") ? true : undefined));
    assert.doesNotMatch(screen(), /second/, "the command has not printed it yet");

    // The command keeps writing; the pager must pick it up on its own.
    await waitFor(() => (screen().includes("second") ? true : undefined));

    // A finished run's log is read once: later writes must not appear.
    pager = undefined;
    await waitFor(() => (backgroundLogs().length > 0 ? true : undefined));
    void commands["bash-logs"]?.("", { ui });
    await waitFor(() => (screen().includes("second") ? true : undefined));
    fs.appendFileSync(logPath, "appended after the run ended\n");
    // Twice the pager's one-second refresh: long enough for a re-read to land.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.doesNotMatch(screen(), /appended after the run ended/);

    fs.rmSync(logPath, { force: true });
  } finally {
    if (previousWindow === undefined) delete process.env.MPI_BASH_FOREGROUND_SECONDS;
    else process.env.MPI_BASH_FOREGROUND_SECONDS = previousWindow;
  }
});

function backgroundLogs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((file) => /^mpi-bash-[\w-]+\.log$/.test(file));
}

/** Poll until `read` returns a value, or fail after 5s. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the detached completion notice");
}

test("bash timeout note states the detach contract and is idempotent", () => {
  const patched = appendBashTimeoutNote("system");
  assert.match(patched, /default timeout of 300 seconds/);
  assert.match(patched, /moved to the background instead of being killed/);
  assert.match(patched, /exit code is delivered to you automatically/);
  assert.equal(appendBashTimeoutNote(patched), patched);
});

test("bash tool calls get the default timeout only when it is missing", async () => {
  type BashToolCall = {
    type: "tool_call";
    toolName: "bash";
    toolCallId: string;
    input: { command: string; timeout?: number };
  };
  const handlers: Record<string, Array<(event: BashToolCall) => void>> = {};
  bashExtension({
    on: (event: string, handler: (event: BashToolCall) => void) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    registerCommand: () => {},
  } as never);

  const event: BashToolCall = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "1",
    input: { command: "pwd" },
  };
  await handlers.tool_call?.[0]?.(event);
  assert.equal(event.input.timeout, 300);

  const explicit: BashToolCall = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "2",
    input: { command: "pwd", timeout: 12 },
  };
  await handlers.tool_call?.[0]?.(explicit);
  assert.equal(explicit.input.timeout, 12);
});

test("foreground window rejects a malformed value instead of defaulting", () => {
  assert.equal(resolveForegroundSeconds({}), 60);
  assert.equal(resolveForegroundSeconds({ MPI_BASH_FOREGROUND_SECONDS: "0" }), 0);
  assert.throws(
    () => resolveForegroundSeconds({ MPI_BASH_FOREGROUND_SECONDS: "soon" }),
    /MPI_BASH_FOREGROUND_SECONDS/,
  );
});

test("the widget lists every run, oldest first, one line each", () => {
  const now = 100_000;
  assert.deepEqual(backgroundRows([], now), []);
  assert.deepEqual(
    backgroundRows(
      [
        { id: 1, command: "sleep 30", startedAt: now - 5_000, logPath: "/tmp/a.log" },
        { id: 2, command: "bun run check", startedAt: now - 72_000, logPath: "/tmp/b.log" },
        { id: 3, command: "pytest  -k \n slow", startedAt: now - 63_000, logPath: "/tmp/c.log" },
      ],
      now,
    ),
    [
      // Oldest first; a newline inside a command would otherwise break the row.
      ["bun run check", "1m12s"],
      ["pytest -k slow", "1m03s"],
      ["sleep 30", "5s"],
    ],
  );
});

test("/bash-logs rows line up in columns and stay unique per run", () => {
  const now = 100_000;
  const rows = [
    formatRunChoice({ id: 111, command: "bun run check", startedAt: now - 8_000, logPath: "/tmp/a.log" }, now),
    formatRunChoice({
      id: 222,
      command: "bun run check",
      startedAt: now - 12_000,
      logPath: "/tmp/b.log",
      exitCode: 0,
      timedOut: false,
      endedAt: now - 1_000,
    }),
    formatRunChoice({
      id: 333,
      command: "pytest -k slow",
      startedAt: now - 30_000,
      logPath: "/tmp/c.log",
      exitCode: 137,
      timedOut: true,
      endedAt: now,
    }),
  ];

  assert.deepEqual(rows, [
    `● running      8s  bun run check${" ".repeat(35)}  #111`,
    `✓ exit 0      11s  bun run check${" ".repeat(35)}  #222`,
    `⏱ timeout     30s  pytest -k slow${" ".repeat(34)}  #333`,
  ]);
  // Same command twice must not collapse into one picker entry.
  assert.equal(new Set(rows).size, rows.length);
});

test("the widget spends one line per run at any width", () => {
  const now = 100_000;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Parameters<typeof renderBackgroundWidget>[1];
  const runs = [
    { id: 1, command: `printf "${"x".repeat(200)}"`, startedAt: now - 5_000, logPath: "/tmp/a.log" },
    { id: 2, command: "bun run check", startedAt: now - 72_000, logPath: "/tmp/b.log" },
  ];

  assert.deepEqual(renderBackgroundWidget([], theme, 60, now), []);

  // The widget sits above the editor, where a wrapped row would silently double
  // its height and push the transcript up.
  for (const width of [30, 40, 80, 200]) {
    const lines = renderBackgroundWidget(runs, theme, width, now);
    assert.equal(lines.length, runs.length, `width ${width} wrapped: ${JSON.stringify(lines)}`);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width} overflowed: ${JSON.stringify(lines)}`,
    );
  }

  const [first, second] = renderBackgroundWidget(runs, theme, 40, now);
  // The clock sits at the right edge, on the same column for every row.
  assert.match(first ?? "", /^ ● bun run check {2,}1m12s\s*$/);
  assert.match(second ?? "", /^ ● printf "x+\u001b\[0m…\u001b\[0m {2,}5s\s*$/);
});

test("a command finishing inside the window streams output and reports its exit code", async () => {
  const output = collector();
  const result = await operations(30).exec('printf "hi\\n"; exit 3', process.cwd(), {
    onData: output.onData,
    env: process.env,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(output.text(), "hi\n");
});

test("a command outliving the window detaches, then reports its exit code out of band", async () => {
  const output = collector();
  const finished = Promise.withResolvers<DetachedRun>();
  const started = Date.now();
  const result = await operations(0.3, (run) => finished.resolve(run)).exec(
    'printf "before\\n"; sleep 1; printf "after\\n"',
    process.cwd(),
    { onData: output.onData, env: process.env, timeout: 30 },
  );

  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started < 900, "the tool call must return at the window, not at command end");
  assert.match(output.text(), /^before\n/);
  assert.match(output.text(), /detached to the background \(pid \d+\)/);
  // The command's shell is a process-group leader, so the advertised stop
  // command must target the group or the inner command survives.
  assert.match(detachNotice(output.text()), /stop it with `kill -- -\d+`/);

  const run = await finished.promise;
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  // Output produced after detaching is kept for the notice and on disk.
  assert.match(run.tail, /^after$/m);
  assert.doesNotMatch(output.text(), /^after$/m);
  // The log is the one place the whole command can be read: the tool result
  // stops at detach, so the log must also carry what was already streamed.
  assert.equal(fs.readFileSync(run.logPath, "utf8"), "before\nafter\n");
  fs.rmSync(run.logPath, { force: true });
});

test("a run's clock starts at the command, not at the detach point", async () => {
  const started = Promise.withResolvers<DetachedStart>();
  const finished = Promise.withResolvers<DetachedRun>();
  const operations = createDetachingBashOperations({
    shellPath: undefined,
    foregroundSeconds: 0.5,
    onDetached: (start) => started.resolve(start),
    onDetachedExit: (run) => finished.resolve(run),
  });
  await operations.exec("sleep 1", process.cwd(), { onData: () => {}, env: process.env });

  const start = await started.promise;
  // The foreground window must already be part of the reported age, or every
  // elapsed time in the UI is short by the whole window.
  assert.ok(
    Date.now() - start.startedAt >= 500,
    `elapsed must include the foreground window, got ${Date.now() - start.startedAt}ms`,
  );
  fs.rmSync((await finished.promise).logPath, { force: true });
});

test("two detached runs never share a log file", async () => {
  const runs: DetachedRun[] = [];
  const ops = () =>
    createDetachingBashOperations({
      shellPath: undefined,
      foregroundSeconds: 0.3,
      onDetachedExit: (run) => runs.push(run),
    });
  await ops().exec('sleep 0.6; printf "first\\n"', process.cwd(), {
    onData: () => {},
    env: process.env,
  });
  await ops().exec('sleep 0.6; printf "second\\n"', process.cwd(), {
    onData: () => {},
    env: process.env,
  });
  await waitFor(() => (runs.length === 2 ? runs : undefined));

  // Pids are reused, so the pid alone would let a new command truncate a
  // finished run's log while `/bash-logs` still points at it.
  assert.notEqual(runs[0]?.logPath, runs[1]?.logPath);
  assert.match(runs[0]?.tail ?? "", /first/);
  assert.match(runs[1]?.tail ?? "", /second/);
  for (const run of runs) fs.rmSync(run.logPath, { force: true });
});

test("pruning removes logs past their retention and keeps the rest", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-bash-prune-"));
  const write = (name: string, ageMs: number) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "x");
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const retention = 60_000;
  const stale = write("mpi-bash-1-1.log", retention * 2);
  const fresh = write("mpi-bash-2-1.log", 0);
  const foreign = write("some-other-tool.log", retention * 2);

  try {
    assert.equal(await pruneOldLogs(Date.now(), dir, retention), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true, "a live command's log must survive");
    assert.equal(fs.existsSync(foreign), true, "only this package's logs are pruned");

    // A missing directory is not an error: bash must keep working regardless.
    assert.equal(await pruneOldLogs(Date.now(), path.join(dir, "gone"), retention), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that never detaches leaves no log behind", async () => {
  const logsBefore = new Set(backgroundLogs());
  const result = await operations(30).exec('printf "hi\\n"', process.cwd(), {
    onData: () => {},
    env: process.env,
  });
  assert.equal(result.exitCode, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    backgroundLogs().filter((file) => !logsBefore.has(file)),
    [],
    "a foreground command's output is already in the tool result",
  );
});

test("a zero foreground window disables detaching", async () => {
  let detached = false;
  const output = collector();
  const result = await operations(0, () => {
    detached = true;
  }).exec('sleep 0.3; printf "late\\n"', process.cwd(), {
    onData: output.onData,
    env: process.env,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(detached, false);
  // Output stops flowing at detach, so a run that detached would lose this.
  assert.equal(output.text(), "late\n");
});

test("a detached command killed by its timeout says so in its notice", async () => {
  const finished = Promise.withResolvers<DetachedRun>();
  const result = await operations(0.3, (run) => finished.resolve(run)).exec(
    "sleep 5",
    process.cwd(),
    { onData: () => {}, env: process.env, timeout: 0.8 },
  );
  // The timeout outlives the window, so the tool call succeeds and the kill is
  // reported out of band instead of as pi's foreground timeout error.
  assert.equal(result.exitCode, 0);

  const run = await finished.promise;
  assert.equal(run.timedOut, true);
  assert.match(formatCompletionNotice(run), /was killed after reaching its timeout/);
  fs.rmSync(run.logPath, { force: true });
});

test("a detached command survives an abort of its turn and still reports", async () => {
  const controller = new AbortController();
  const finished = Promise.withResolvers<DetachedRun>();
  const result = await operations(0.3, (run) => finished.resolve(run)).exec(
    'sleep 1; printf "survived\\n"',
    process.cwd(),
    { onData: () => {}, env: process.env, signal: controller.signal, timeout: 30 },
  );
  assert.equal(result.exitCode, 0);

  controller.abort();
  const run = await finished.promise;
  assert.equal(run.exitCode, 0, "abort after detach must not kill the background command");
  assert.match(run.tail, /^survived$/m);
  fs.rmSync(run.logPath, { force: true });
});

test("aborting a foreground command surfaces pi's abort contract", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    operations(30).exec("sleep 5", process.cwd(), {
      onData: () => {},
      env: process.env,
      signal: controller.signal,
    }),
    /^Error: aborted$/,
  );
});

test("a command killed by its timeout surfaces pi's timeout contract", async () => {
  await assert.rejects(
    operations(30).exec("sleep 5", process.cwd(), {
      onData: () => {},
      env: process.env,
      timeout: 0.3,
    }),
    /^Error: timeout:0.3$/,
  );
});

test("pi's timeout and cwd validation still rejects before spawning", async () => {
  await assert.rejects(
    operations(30).exec("true", process.cwd(), { onData: () => {}, env: process.env, timeout: 0 }),
    /Invalid timeout/,
  );
  await assert.rejects(
    operations(30).exec("true", "/definitely/not/a/directory", {
      onData: () => {},
      env: process.env,
    }),
    /Working directory does not exist/,
  );
});

test("the registered bash tool detaches, shows the widget, and reports without waking the agent", async () => {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const messages: Array<{ customType: string; content: string; triggerTurn: unknown }> = [];
  type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[] };
  const widgets: Array<WidgetFactory | undefined> = [];
  const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  let bash: BashTool | undefined;

  const previousWindow = process.env.MPI_BASH_FOREGROUND_SECONDS;
  process.env.MPI_BASH_FOREGROUND_SECONDS = "0.3";
  try {
    bashExtension({
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[event] ??= [];
        handlers[event].push(handler);
      },
      registerCommand: () => {},
      registerTool: (tool: BashTool) => {
        bash = tool;
      },
      sendMessage: (
        message: { customType: string; content: string },
        options?: { triggerTurn?: boolean },
      ) => {
        messages.push({ ...message, triggerTurn: options?.triggerTurn });
      },
    } as never);

    await handlers.session_start?.[0]?.(
      {},
      {
        cwd: process.cwd(),
        ui: {
          setWidget: (_key: string, content: WidgetFactory | undefined) => widgets.push(content),
        },
      },
    );
    assert.equal(bash?.name, "bash");

    const result = await bash?.execute("call-1", {
      command: 'sleep 1; printf "late\\n"',
      timeout: 30,
    });
    assert.match(result?.content[0]?.text ?? "", /detached to the background/);
    const rendered = widgets
      .filter((factory): factory is WidgetFactory => factory !== undefined)
      .flatMap((factory) => factory(undefined, plainTheme).render(80));
    assert.ok(
      rendered.some((line) => line.includes("sleep 1; printf")),
      `the running command must be visible in the widget: ${JSON.stringify(rendered)}`,
    );

    const notice = await waitFor(() => messages[0]);
    assert.equal(notice.customType, "bash-detached-exit");
    // Waking an idle agent for a finished background command is the hazard this
    // whole delivery path exists to avoid.
    assert.equal(notice.triggerTurn, false);
    assert.match(notice.content, /exited with code 0/);
    assert.equal(widgets.at(-1), undefined, "the widget must clear with the last run");

    const logPath = /Complete output \(foreground and background\): (\S+)/.exec(notice.content)?.[1];
    assert.ok(logPath, `the notice must name the complete log: ${notice.content}`);
    assert.equal(fs.readFileSync(logPath, "utf8"), "late\n");
    fs.rmSync(logPath, { force: true });
  } finally {
    if (previousWindow === undefined) delete process.env.MPI_BASH_FOREGROUND_SECONDS;
    else process.env.MPI_BASH_FOREGROUND_SECONDS = previousWindow;
  }
});
