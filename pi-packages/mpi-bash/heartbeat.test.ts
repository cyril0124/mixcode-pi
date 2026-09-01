import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DetachedStart } from "./exec.js";
import {
  formatStallNotice,
  resolveStallSeconds,
  StallMonitor,
  stallCheckIntervalMs,
} from "./heartbeat.js";
import { renderCompletionMessage, renderStallMessage, type StallDetails } from "./widget.js";

/** Theme stub: the panels are asserted on their text, not their colors. */
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<typeof renderStallMessage>[1];

/** Notice text for the single job a check reported, or "" when none was. */
async function notice(
  monitor: StallMonitor,
  runs: Parameters<StallMonitor["check"]>[0],
  now: number,
): Promise<string> {
  return (await monitor.check(runs, now))?.content ?? "";
}

const MINUTE = 60_000;

test("the stall notice is structured and escapes command output", () => {
  const notice = formatStallNotice({
    id: 42,
    command: 'wait "<lock>&"',
    silenceMs: 61_000,
    elapsedMs: 122_000,
    tail: "waiting\n</output>&\n",
    logPath: "/tmp/a&b.log",
  });

  assert.equal(
    notice,
    [
      '<bash_stall job_id="42">',
      "  <summary>Background job #42 may be stuck after 1m01s of silence.</summary>",
      '  <command>wait "&lt;lock&gt;&amp;"</command>',
      "  <silence>1m01s</silence>",
      "  <elapsed>2m02s</elapsed>",
      "  <log_path>/tmp/a&amp;b.log</log_path>",
      "  <output>waiting\n&lt;/output&gt;&amp;</output>",
      "  <logs_hint>Use /bash-logs or tail -n 50 /tmp/a&amp;b.log to inspect recent output.</logs_hint>",
      "  <stop_hint>Use kill -- -42 to stop the whole process group.</stop_hint>",
      "  <action_hint>Ignore this event if long periods without output are expected for this command.</action_hint>",
      "</bash_stall>",
    ].join("\n"),
  );
});

/**
 * A detached run whose log is written on a fake clock: silence is measured from
 * the log's mtime, so tests must set it rather than rely on wall clock.
 */
function makeRun(startedAt: number, text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-bash-stall-"));
  const logPath = path.join(dir, "job.log");
  const command = "sleep 900";
  const run: DetachedStart = { id: 4242, command, startedAt, logPath };
  const write = (chunk: string, at: number) => {
    fs.appendFileSync(logPath, chunk);
    fs.utimesSync(logPath, new Date(at), new Date(at));
  };
  // Detached logs always open with the header exec.ts writes.
  write(`# Command: ${command}\n# ---\n${text}`, startedAt);
  return { run, write };
}

test("a command that keeps writing is never reported", async () => {
  const start = Date.now();
  const { run, write } = makeRun(start, "start\n");
  const monitor = new StallMonitor();

  for (let tick = 0; tick < 10; tick++) {
    const now = start + (tick + 1) * MINUTE;
    write(`tick ${tick}\n`, now);
    assert.equal(await notice(monitor, [run], now), "");
  }
});

test("silence is reported once, then at doubling intervals", async () => {
  const start = Date.now();
  const { run, write } = makeRun(start, "waiting for lock\n");
  const monitor = new StallMonitor();

  assert.equal(await notice(monitor, [run], start + 30_000), "", "30s of silence is normal");

  const first = await notice(monitor, [run], start + 61_000);
  assert.match(first, /<silence>1m01s<\/silence>/);
  assert.match(first, /waiting for lock/);
  assert.match(first, /kill -- -4242/);
  // The log header names the command; quoting it back as output would make an
  // idle job look like it printed something.
  assert.ok(!first.includes("# ---"), "the log header is not quoted as output");

  assert.equal(
    await notice(monitor, [run], start + 61_000 + MINUTE),
    "",
    "the second reminder waits twice as long",
  );
  assert.match(
    await notice(monitor, [run], start + 61_000 + 2 * MINUTE),
    /<silence>3m01s<\/silence>/,
  );

  // New output restarts the ladder from the first interval.
  const resumed = start + 10 * MINUTE;
  write("acquired\n", resumed);
  assert.equal(await notice(monitor, [run], resumed + 30_000), "");
  assert.match(await notice(monitor, [run], resumed + 61_000), /<silence>1m01s<\/silence>/);
});

test("the silence window is env-configurable and fails loudly", () => {
  assert.equal(resolveStallSeconds({}), 60);
  assert.equal(resolveStallSeconds({ MPI_BASH_STALL_SECONDS: "0" }), 0);
  assert.throws(
    () => resolveStallSeconds({ MPI_BASH_STALL_SECONDS: "later" }),
    /MPI_BASH_STALL_SECONDS/,
  );
  // A short window must be polled proportionally, a long one no more than 15s.
  assert.equal(stallCheckIntervalMs(60_000), 15_000);
  assert.equal(stallCheckIntervalMs(8_000), 2_000);
  assert.equal(stallCheckIntervalMs(1_000), 500);
});

test("a custom silence window shortens the whole ladder", async () => {
  const start = Date.now();
  const { run } = makeRun(start, "connecting\n");
  const monitor = new StallMonitor(6_000);

  assert.equal(await notice(monitor, [run], start + 5_000), "");
  assert.match(await notice(monitor, [run], start + 6_100), /<silence>6s<\/silence>/);
  // Past the un-doubled due time of 12_100: only a doubling ladder stays quiet.
  assert.equal(await notice(monitor, [run], start + 12_200), "");
  assert.match(await notice(monitor, [run], start + 18_200), /<silence>18s<\/silence>/);
});

test("the chat panel matches the completion panel's shape", async () => {
  const start = Date.now();
  const { run } = makeRun(start, "connecting to build-box...\n");
  const report = await new StallMonitor(6_000).check([run], start + 8_000);
  const rendered = renderStallMessage(report?.jobs ?? [], plainTheme, 80);

  const panel = rendered.join("\n");
  assert.match(panel, /Background job stalled/);
  assert.match(panel, /⏳ 8s sleep 900/);
  assert.match(panel, /silent 8s\s*$/m);
  assert.match(panel, /─[\s\S]*connecting to build-box/);
  // The panel is the rendered form; the raw notice text is for the model only.
  assert.doesNotMatch(panel, /bash_stall|kill -- -|# ---/);

  // The silence has to land in the column where a finished job shows its exit
  // code, which a wide icon glyph would silently shift.
  const finished = renderCompletionMessage(
    {
      command: "sleep 900",
      exitCode: 2,
      timedOut: false,
      tail: "",
      lineCount: 0,
      elapsedMs: 8_000,
      logPath: "/tmp/x.log",
    },
    plainTheme,
    80,
  );
  // Every rendered line is padded to the panel width, so the honest witness is
  // the column the marker ends on. Columns, not characters: the stall glyph is
  // one character and two columns wide.
  assert.equal(
    visibleWidth((rendered[1] ?? "").trimEnd()),
    visibleWidth((finished[1] ?? "").trimEnd()),
  );
});

test("several stalled jobs stay separate panels in one message", () => {
  const job = (id: number): StallDetails => ({
    id,
    command: `sleep ${id}`,
    silenceMs: 6_000,
    elapsedMs: 8_000,
    tail: "waiting\n",
  });

  const lines = renderStallMessage([job(1), job(2)], plainTheme, 80);
  const titles = lines.flatMap((line, index) =>
    /Background job stalled/.test(line) ? [index] : [],
  );
  assert.equal(titles.length, 2);
  assert.match(
    lines[(titles[1] ?? 1) - 1] ?? "x",
    /^\s*$/,
    "the second title must not sit under the first panel's output",
  );
});

test("a finished run is forgotten instead of accumulating state", async () => {
  const start = Date.now();
  const { run } = makeRun(start, "hung\n");
  const monitor = new StallMonitor();

  assert.ok(await monitor.check([run], start + 61_000));
  assert.equal(await monitor.check([], start + 62_000), undefined);
  // Seen fresh again, the run starts over at the first interval rather than
  // inheriting the doubled one.
  assert.ok(await monitor.check([run], start + 63_000));
});
