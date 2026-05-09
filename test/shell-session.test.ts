import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendShellOutput, createTab, ShellManager } from "../src/index.js";
import type { ShellSessionInfo } from "../src/index.js";

test("shell output is normalized and capped for rendering", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.shellSession = { cwd: "/repo", command: "sh", buffer: [], input: "" };
  appendShellOutput(tab.shellSession, "a\r\nb\n", 3);
  appendShellOutput(tab.shellSession, "c\nd\ne\n", 3);
  assert.deepEqual(tab.shellSession.buffer, ["c", "d", "e"]);
});

test("shell output tracks terminal mouse and alternate-screen modes", () => {
  const session: ShellSessionInfo = { cwd: "/repo", command: "sh", buffer: [], input: "" };
  appendShellOutput(session, "\x1b[?1049h\x1b[?1000h\x1b[?1006h");
  assert.equal(session.alternateScreen, true);
  assert.equal(session.normalMouse, true);
  assert.equal(session.sgrMouse, true);
  appendShellOutput(session, "\x1b[?1006l\x1b[?1000l\x1b[?1049l");
  assert.equal(session.alternateScreen, false);
  assert.equal(session.normalMouse, false);
  assert.equal(session.sgrMouse, false);
});

test("shell output strips terminal controls from the render buffer", () => {
  const session: ShellSessionInfo = { cwd: "/repo", command: "sh", buffer: [], input: "" };
  appendShellOutput(session, "\x1b[?1049h\x1b[2J\x1b[HHELLO");

  assert.equal(session.alternateScreen, true);
  assert.deepEqual(session.buffer, ["HELLO"]);
  assert.equal(session.buffer.join("\n").includes("\x1b[?1049h"), false);
  assert.equal(session.buffer.join("\n").includes("\x1b[2J"), false);
  assert.equal(session.buffer.join("\n").includes("\x1b[H"), false);
});

test("shell output strips OSC, APC, and cursor controls from the render buffer", () => {
  const session: ShellSessionInfo = { cwd: "/repo", command: "sh", buffer: [], input: "" };
  appendShellOutput(session, "A\x1b]0;title\x07B\x1b_Gignored\x1b\\C\x1b[12;34HD");

  assert.deepEqual(session.buffer, ["ABCD"]);
  assert.equal(session.buffer.join("\n").includes("\x1b]0;title\x07"), false);
  assert.equal(session.buffer.join("\n").includes("\x1b_Gignored\x1b\\"), false);
  assert.equal(session.buffer.join("\n").includes("\x1b[12;34H"), false);
});

test("shell manager maps mouse events to terminal input modes", () => {
  const manager = new ShellManager();
  const tab = createTab(1, "s1", "/repo");
  assert.equal(manager.write(tab, "x"), false);
  assert.equal(manager.writeMouse(tab, { button: 0, x: 1, y: 1, release: false }), false);
  tab.shellSession = { cwd: "/repo", command: "sh", buffer: [], input: "", sgrMouse: true };
  const written: string[] = [];
  const fake = { stdin: { write: (data: string) => written.push(data) }, kill: () => undefined };
  (manager as unknown as { processes: Map<string, unknown> }).processes.set("s1", fake);

  assert.equal(manager.write(tab, "x"), true);
  assert.equal(tab.shellSession.input, "x");
  assert.equal(written.at(-1), "x");
  assert.equal(
    manager.writeMouse(tab, { button: 64, x: 3, y: 2, release: false, wheel: "up" }),
    true,
  );
  assert.deepEqual(written.slice(-1), ["\x1b[<64;3;2M"]);
  assert.equal(manager.writeMouse(tab, { button: 0, x: 3, y: 2, release: false }), true);
  assert.equal(manager.writeMouse(tab, { button: 3, x: 3, y: 2, release: true }), true);
  assert.deepEqual(written.slice(-2), ["\x1b[<0;3;2M", "\x1b[<3;3;2m"]);
  tab.shellSession.sgrMouse = false;
  tab.shellSession.alternateScreen = true;
  assert.equal(
    manager.writeMouse(tab, { button: 65, x: 3, y: 2, release: false, wheel: "down" }),
    true,
  );
  assert.equal(written.at(-1), "\x1b[B");
  assert.equal(
    manager.writeMouse(tab, { button: 64, x: 3, y: 2, release: false, wheel: "up" }),
    true,
  );
  assert.equal(written.at(-1), "\x1b[A");
  tab.shellSession.alternateScreen = false;
  assert.equal(
    manager.writeMouse(tab, { button: 65, x: 3, y: 2, release: false, wheel: "down" }),
    false,
  );
  tab.shellSession.input = "abc";
  assert.equal(manager.write(tab, "\u007f"), true);
  assert.equal(tab.shellSession.input, "ab");
  assert.equal(manager.write(tab, "\b"), true);
  assert.equal(tab.shellSession.input, "a");
  assert.equal(manager.write(tab, "\x1b[A"), true);
  assert.equal(written.at(-1), "\x1b[A");
  manager.close(tab);
});

test("shell manager covers input controls and close without a child process", () => {
  const manager = new ShellManager();
  const tab = createTab(1, "s1", "/repo");
  const written: string[] = [];
  const fake = { stdin: { write: (data: string) => written.push(data) }, kill: () => undefined };
  tab.shellSession = { cwd: "/repo", command: "sh", buffer: [], input: "" };
  (manager as unknown as { processes: Map<string, unknown> }).processes.set("s1", fake);

  assert.equal(manager.write(tab, "\r"), true);
  assert.deepEqual(tab.shellSession.buffer, ["$ "]);
  assert.equal(tab.shellSession.input, "");
  assert.equal(written.at(-1), "\n");

  tab.shellSession.input = "abc";
  assert.equal(manager.write(tab, "\u0003"), true);
  assert.equal(tab.shellSession.input, "");
  assert.equal(written.at(-1), "\u0003");

  assert.equal(manager.write(tab, "\u001f"), true);
  assert.equal(tab.shellSession.input, "");
  assert.equal(written.at(-1), "\u001f");

  (manager as unknown as { processes: Map<string, unknown> }).processes.delete("s1");
  manager.close(tab);
  assert.equal(tab.shellOpen, false);
  assert.equal(tab.shellScrollOffset, 0);
});

test("shell manager records signal-only exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-shell-signal-"));
  const manager = new ShellManager();
  const tab = createTab(1, "s1", dir);
  try {
    const session = manager.open(tab, "sh");
    assert.equal(manager.write(tab, "kill -TERM $$"), true);
    assert.equal(manager.write(tab, "\r"), true);
    await waitFor(() => session.signal === "SIGTERM");
    assert.equal(session.exitCode, undefined);
    assert.match(session.buffer.at(-1) ?? "", /SIGTERM/);
  } finally {
    manager.close(tab);
    await rm(dir, { recursive: true, force: true });
  }
});

test("shell manager starts, writes to, reuses, and closes a real shell process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-shell-"));
  const manager = new ShellManager();
  const tab = createTab(1, "s1", dir);
  try {
    const session = manager.open(tab, "sh");
    assert.equal(tab.shellOpen, true);
    assert.equal(manager.isRunning(tab), true);
    assert.equal(manager.open(tab, "sh"), session);
    assert.equal(manager.write(tab, "printf shell-ok"), true);
    assert.equal(manager.write(tab, "\r"), true);
    assert.equal(tab.shellSession?.input, "");
    await waitFor(() => session.buffer.join("\n").includes("shell-ok"));
    assert.equal(manager.write(tab, "\t"), true);
    assert.equal(manager.write(tab, "sleep 5"), true);
    assert.equal(manager.write(tab, "\u0003"), true);
    assert.equal(tab.shellSession?.input, "");
    manager.close(tab);
    assert.equal(tab.shellOpen, false);
    assert.equal(manager.isRunning(tab), false);
    assert.equal(manager.write(tab, "x"), false);
  } finally {
    manager.close(tab);
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for shell output");
}
