import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { $ } from "bun";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ChatSurfaceBounds } from "../src/core/chat-selection.js";

interface Frame {
  phase: string;
  lines: string[];
  bounds: ChatSurfaceBounds;
  scrollOffset: number;
  terminalOutput: string;
}

async function waitForFrame(dir: string, phase: string): Promise<Frame> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let frame: Frame | undefined;
    try {
      frame = await Bun.file(path.join(dir, "frame.json")).json();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (frame?.phase === phase) return frame;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for the ${phase} terminal frame`);
}

for (const [key, phase] of [
  ["d", "shifted"],
  ["m", "margins"],
  ["o", "origin"],
  ["f", "full-redraw"],
  ["s", "restarted"],
] as const) {
  test(`full-screen incremental painting restores terminal state after ${phase}`, {
    skip: !Bun.which("tmux") && "tmux is required for terminal screen validation",
  }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-viewport-cursor-"));
    const socket = `viewport-cursor-${process.pid}-${phase}`;
    const scenario = path.join(import.meta.dir, "helpers/viewport-cursor-scenario.ts");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `env PI_OFFLINE=1 PI_PACKAGE_DIR='' PI_CODING_AGENT_DIR=${quote(dir)} bun ${quote(scenario)} ${quote(dir)}`;
    try {
      await $`tmux -L ${socket} new-session -d -s test -x 100 -y 30 ${command}`.quiet();
      const baseline = await waitForFrame(dir, "baseline");
      const expectedBaseline = baseline.lines.map((line) => stripTerminalSequences(line).trimEnd());
      assert.match(expectedBaseline[1]!, /terminal-cursor-example-tab-/);
      const readScreen = async () => {
        const text = await $`tmux -L ${socket} capture-pane -p -t test`.text();
        return text
          .split("\n")
          .slice(0, 30)
          .map((line) => line.trimEnd());
      };
      assert.deepEqual(await readScreen(), expectedBaseline);

      await $`tmux -L ${socket} send-keys -t test ${key}`.quiet();
      const shifted = await waitForFrame(dir, phase);
      const actual = await readScreen();
      assert.equal(actual.filter((line) => line.includes("Jump to latest")).length, 1);
      assert.deepEqual(
        actual,
        shifted.lines.map((line) => stripTerminalSequences(line).trimEnd()),
        "terminal state must not duplicate chrome or shift the transcript",
      );
    } finally {
      // This socket belongs only to this test.
      await $`tmux -L ${socket} kill-server`.quiet().nothrow();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test("Vim gg displays the first chat row after scrolling in a real terminal", {
  skip: !Bun.which("tmux") && "tmux is required for terminal screen validation",
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-viewport-home-"));
  const socket = `viewport-home-${process.pid}`;
  const scenario = path.join(import.meta.dir, "helpers/viewport-cursor-scenario.ts");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `env PI_OFFLINE=1 PI_PACKAGE_DIR='' PI_CODING_AGENT_DIR=${quote(dir)} bun ${quote(scenario)} ${quote(dir)} home`;
  try {
    await $`tmux -L ${socket} new-session -d -s test -x 100 -y 30 ${command}`.quiet();
    await waitForFrame(dir, "baseline");
    await $`tmux -L ${socket} send-keys -t test g g`.quiet();
    const home = await waitForFrame(dir, "home");
    const screen = (await $`tmux -L ${socket} capture-pane -p -t test`.text()).split("\n");
    assert.match(screen[home.bounds.top - 1]!, /ROW-0-0\b/);
    assert.doesNotMatch(screen.join("\n"), /older above/);
  } finally {
    // This socket belongs only to this test.
    await $`tmux -L ${socket} kill-server`.quiet().nothrow();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const longStreaming of [false, true]) {
  test(`selecting ${longStreaming ? "long streaming output" : "the live tail"} keeps terminal rows stationary`, {
    skip: !Bun.which("tmux") && "tmux is required for terminal screen validation",
  }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-viewport-tail-"));
    const socket = `viewport-tail-${process.pid}-${longStreaming ? "long" : "short"}`;
    const scenario = path.join(import.meta.dir, "helpers/viewport-cursor-scenario.ts");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `env PI_OFFLINE=1 PI_PACKAGE_DIR='' PI_CODING_AGENT_DIR=${quote(dir)} bun ${quote(scenario)} ${quote(dir)} ${longStreaming ? "long" : ""}`;
    const readScreen = async () =>
      (await $`tmux -L ${socket} capture-pane -p -t test`.text()).split("\n");
    try {
      await $`tmux -L ${socket} new-session -d -s test -x 100 -y 30 ${command}`.quiet();
      await waitForFrame(dir, "baseline");
      await $`tmux -L ${socket} send-keys -t test t`.quiet();
      const { bounds } = await waitForFrame(dir, "tail");
      const unselected = await readScreen();
      const firstContentRow = unselected.findIndex((line) => /ROW-\d+ 中文 text/.test(line));
      assert.ok(firstContentRow >= 0, "long streaming preview must expose content rows");
      const firstSelectedRow = longStreaming ? firstContentRow + 1 : bounds.top + 3;
      const lastSelectedRow = bounds.top + bounds.height - 4;
      const selectedRows = (lines: string[]) =>
        lines
          .slice(firstSelectedRow - 1, lastSelectedRow)
          .map((line) => sliceByColumn(line, bounds.left - 1, bounds.width));
      for (const input of [`\x1b[<0;20;${lastSelectedRow}M`, `\x1b[<32;1;${firstSelectedRow}M`]) {
        await $`tmux -L ${socket} send-keys -t test -l ${input}`.quiet();
      }
      await $`tmux -L ${socket} send-keys -t test p`.quiet();
      await waitForFrame(dir, "dragged");
      const before = await readScreen();
      assert.match(before[firstSelectedRow - 1]!, /ROW-\d+ 中文 text/);
      assert.deepEqual(
        selectedRows(before),
        selectedRows(unselected),
        "selection moved existing rows",
      );

      await $`tmux -L ${socket} send-keys -t test g`.quiet();
      await waitForFrame(dir, "grown");
      const after = await readScreen();
      assert.deepEqual(
        selectedRows(after),
        selectedRows(before),
        "new output must not move the selected terminal cells",
      );
    } finally {
      await $`tmux -L ${socket} kill-server`.quiet().nothrow();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test("selecting within the first Markdown row preserves terminal cells without prompt-zone escapes", {
  skip: !Bun.which("tmux") && "tmux is required for terminal screen validation",
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-viewport-prompt-zones-"));
  const socket = `viewport-prompt-zones-${process.pid}`;
  const scenario = path.join(import.meta.dir, "helpers/viewport-cursor-scenario.ts");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `env PI_OFFLINE=1 PI_PACKAGE_DIR='' PI_CODING_AGENT_DIR=${quote(dir)} bun ${quote(scenario)} ${quote(dir)} prompt-zones`;
  const readScreen = async () =>
    (await $`tmux -L ${socket} capture-pane -p -t test`.text()).split("\n");
  try {
    await $`tmux -L ${socket} new-session -d -s test -x 180 -y 30 ${command}`.quiet();
    await waitForFrame(dir, "baseline");
    const before = await readScreen();
    const row = before.findIndex((line) => line.includes("MakeInvalid"));
    assert.ok(row >= 0, "the complete word must appear before selection");
    const line = before[row]!;
    const start = line.indexOf("没有");
    assert.ok(start >= 0, "the selection starts in the mixed CJK/ASCII paragraph");
    const column = visibleWidth(line.slice(0, start)) + 1;
    for (const input of [`\x1b[<0;${column};${row + 1}M`, `\x1b[<32;${column + 13};${row + 1}M`]) {
      await $`tmux -L ${socket} send-keys -t test -l ${input}`.quiet();
    }
    await $`tmux -L ${socket} send-keys -t test p`.quiet();
    const dragged = await waitForFrame(dir, "dragged");
    assert.deepEqual(await readScreen(), before, "highlighting must not move or split text");
    assert.match(Bun.stripANSI(dragged.terminalOutput), /MakeInvalid/);
    assert.doesNotMatch(dragged.terminalOutput, /\x1b\]133;/);
  } finally {
    // This socket belongs only to this test.
    await $`tmux -L ${socket} kill-server`.quiet().nothrow();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat drags use the host viewport and preserve the parent terminal screen", {
  skip: !Bun.which("tmux") && "tmux is required for terminal screen validation",
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-viewport-drag-"));
  const socket = `viewport-drag-${process.pid}`;
  const scenario = path.join(import.meta.dir, "helpers/viewport-cursor-scenario.ts");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `env PI_OFFLINE=1 PI_PACKAGE_DIR='' PI_CODING_AGENT_DIR=${quote(dir)} bun ${quote(scenario)} ${quote(dir)}`;
  try {
    await $`tmux -L ${socket} new-session -d -s test -x 100 -y 30 ${command}`.quiet();
    const baseline = await waitForFrame(dir, "baseline");
    const bounds = baseline.bounds;
    for (const input of [
      `\x1b[<0;20;${bounds.top + bounds.height - 3}M`,
      `\x1b[<32;1;${bounds.top}M`,
    ]) {
      await $`tmux -L ${socket} send-keys -t test -l ${input}`.quiet();
    }
    const firstRowNumber = (lines: string[]) => Number(lines.join("\n").match(/ROW-(\d+)/)?.[1]);
    const before = firstRowNumber(baseline.lines);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const screen = await $`tmux -L ${socket} capture-pane -p -t test`.text();
      if (firstRowNumber(screen.split("\n")) < before) break;
      await Bun.sleep(20);
    }
    await $`tmux -L ${socket} send-keys -t test p`.quiet();
    const dragged = await waitForFrame(dir, "dragged");
    assert.ok(dragged.scrollOffset > baseline.scrollOffset, "edge dragging must scroll the chat");
    const selected = await $`tmux -L ${socket} capture-pane -p -t test`.text();
    assert.equal(selected.split("\n").filter((line) => line.includes("Jump to latest")).length, 1);

    await $`tmux -L ${socket} send-keys -t test q`.quiet();
    await waitForFrame(dir, "stopped");
    const parent = await $`tmux -L ${socket} capture-pane -p -t test`.text();
    assert.match(parent, /PARENT-SCREEN-SENTINEL/);
    assert.doesNotMatch(parent, /Jump to latest|ROW-\d+/);
  } finally {
    await $`tmux -L ${socket} kill-server`.quiet().nothrow();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
