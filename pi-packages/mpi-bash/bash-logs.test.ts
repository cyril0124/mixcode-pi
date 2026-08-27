import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BashLogs } from "./bash-logs.js";
import type { DetachedStart } from "./exec.js";
import type { FinishedRun } from "./widget.js";

const theme = { fg: (_color: string, value: string) => value };

function writeLog(name: string, text: string): string {
  const logPath = path.join(os.tmpdir(), name);
  fs.writeFileSync(logPath, text);
  return logPath;
}

function running(id: number, command: string, logPath: string): DetachedStart {
  return { id, command, startedAt: Date.now() - 5_000, logPath };
}

function finished(id: number, command: string, logPath: string): FinishedRun {
  const startedAt = Date.now() - 8_000;
  return {
    id,
    command,
    startedAt,
    logPath,
    exitCode: 1,
    timedOut: false,
    endedAt: startedAt + 3_000,
  };
}

function overlay(
  runs: Array<DetachedStart | FinishedRun>,
  options: {
    initialText?: string;
    kill?: (run: DetachedStart | FinishedRun) => void;
    terminalRows?: number;
  } = {},
) {
  let closed = false;
  const view = new BashLogs({
    theme,
    list: () => runs,
    requestRender: () => {},
    done: () => {
      closed = true;
    },
    openExternal: () => {},
    kill: options.kill ?? (() => {}),
    initialText: options.initialText,
    followMs: 0,
    terminalRows: () => options.terminalRows ?? 40,
  });
  return {
    view,
    isClosed: () => closed,
    screen: () => view.render(80).join("\n"),
    lines: () => view.render(80),
  };
}

test("the overlay shows the job list and the selected log together", () => {
  const logPath = writeLog(`mpi-bash-overlay-${process.pid}-a.log`, "early\nlate\n");
  try {
    const { screen } = overlay([running(11, 'printf "early"', logPath)], {
      initialText: "early\nlate\n",
    });
    const text = screen();
    assert.match(text, /1\/1 running ── Bash logs/);
    assert.match(text, /> ● running/);
    assert.match(text, /printf "early"/);
    assert.match(text, /#11/);
    assert.match(text, /early/);
    assert.match(text, /late/);
    assert.match(text, /j\/k move/);
    assert.match(text, /J\/K scroll/);
    assert.match(text, /x kill/);
    // 40-row terminal → 0.6*40 - 6 chrome - 1 list = 17 preview + 7 chrome = 24.
    assert.equal(text.split("\n").length, 24);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test("preview height is 60% of the terminal minus chrome", () => {
  const logPath = writeLog(`mpi-bash-overlay-${process.pid}-ratio.log`, "line\n");
  try {
    const short = overlay([running(1, "cmd", logPath)], {
      initialText: "line\n",
      terminalRows: 24,
    }).lines().length;
    const tall = overlay([running(1, "cmd", logPath)], {
      initialText: "line\n",
      terminalRows: 48,
    }).lines().length;
    // 24*0.6 - 6 - 1 = 7 → floor 8 preview + 7 chrome = 15
    // 48*0.6 - 6 - 1 = 21 preview + 7 chrome = 28
    assert.equal(short, 15);
    assert.equal(tall, 28);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test("j and k change jobs; J and K scroll the log", async () => {
  const firstPath = writeLog(
    `mpi-bash-overlay-${process.pid}-j.log`,
    Array.from({ length: 40 }, (_, index) => `alpha ${index + 1}`).join("\n"),
  );
  const secondPath = writeLog(`mpi-bash-overlay-${process.pid}-k.log`, "beta only\n");
  try {
    const { view, screen } = overlay(
      [running(1, "alpha-job", firstPath), running(2, "beta-job", secondPath)],
      { initialText: fs.readFileSync(firstPath, "utf8") },
    );

    const before = screen();
    assert.match(before, /> ● running.*alpha-job/);
    assert.match(before, / {2}● running.*beta-job/);
    assert.match(before, /alpha 40/);

    view.handleInput("j");
    await view.pending();
    const second = screen();
    assert.match(second, / {2}● running.*alpha-job/);
    assert.match(second, /> ● running.*beta-job/);
    assert.match(second, /beta only/);
    assert.doesNotMatch(second, /alpha 40/);

    view.handleInput("k");
    await view.pending();
    assert.match(screen(), /> ● running.*alpha-job/);
    assert.match(screen(), /alpha 40/);

    view.handleInput("g");
    assert.match(screen(), /alpha 1\b/);
    view.handleInput("J");
    assert.match(screen(), /alpha 2\b/);
    view.handleInput("K");
    assert.match(screen(), /alpha 1\b/);
    assert.match(screen(), /> ● running.*alpha-job/, "J/K must not change the selected job");
  } finally {
    fs.rmSync(firstPath, { force: true });
    fs.rmSync(secondPath, { force: true });
  }
});

test("x kill confirmation swallows j instead of changing jobs", () => {
  const firstPath = writeLog(`mpi-bash-overlay-${process.pid}-x1.log`, "one\n");
  const secondPath = writeLog(`mpi-bash-overlay-${process.pid}-x2.log`, "two\n");
  const killed: number[] = [];
  try {
    const { view, screen } = overlay(
      [running(21, "one-job", firstPath), running(22, "two-job", secondPath)],
      {
        initialText: "one\n",
        kill: (run) => killed.push(run.id),
      },
    );
    view.handleInput("x");
    assert.match(screen(), /kill job #21/);
    view.handleInput("j");
    assert.deepEqual(killed, []);
    assert.match(screen(), /> ● running.*one-job/, "a cancelled x must not move the list");
    assert.doesNotMatch(screen(), /kill job/);
    view.handleInput("x");
    view.handleInput("y");
    assert.deepEqual(killed, [21]);
  } finally {
    fs.rmSync(firstPath, { force: true });
    fs.rmSync(secondPath, { force: true });
  }
});

test("q closes the overlay", () => {
  const logPath = writeLog(`mpi-bash-overlay-${process.pid}-q.log`, "bye\n");
  try {
    const { view, isClosed } = overlay([finished(9, "done-job", logPath)], {
      initialText: "bye\n",
    });
    assert.equal(isClosed(), false);
    view.handleInput("q");
    assert.equal(isClosed(), true);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});
