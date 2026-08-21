import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("tmux TUI shows separate Steer and Follow-up queues", {
  skip:
    process.env.MIXCODE_RUN_TMUX_FOLLOWUP !== "1"
      ? "set MIXCODE_RUN_TMUX_FOLLOWUP=1 to run real tmux follow-up TUI smoke"
      : false,
}, async () => {
  const tmux = await resolveTmux();
  const repo = path.resolve(".");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-followup-tmux-"));
  // Isolated socket label — never use default socket kill-server.
  const label = `mixcode-followup-${process.pid}-${Date.now()}`;
  const session = "followup";
  const marker = path.join(dir, "ready.json");
  const capturePath = path.join(dir, "pane.txt");

  try {
    const harness = path.resolve(repo, "test/follow-up-tui-harness.ts");
    const cmd = [
      `MIXCODE_FOLLOWUP_HARNESS_DIR=${shellQuote(dir)}`,
      `MIXCODE_FOLLOWUP_MARKER=${shellQuote(marker)}`,
      `bun ${shellQuote(harness)}`,
    ].join(" ");

    await tmuxRun(tmux, label, [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "140",
      "-y",
      "40",
      "-c",
      repo,
      cmd,
    ]);

    // Wait for harness marker (queues ready in state).
    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const raw = await fsPromises.readFile(marker, "utf8");
        const data = JSON.parse(raw) as {
          pendingMessages: string[];
          pendingFollowUps: string[];
        };
        if (
          data.pendingMessages?.includes("steer now") &&
          data.pendingFollowUps?.includes("follow later")
        ) {
          ready = true;
          break;
        }
      } catch {
        // not ready
      }
      await delay(200);
    }
    assert.equal(ready, true, "harness did not report dual queues ready");

    const pane = await waitForPane(
      tmux,
      label,
      session,
      (plain) => /Steer \(1\)/.test(plain) && /Follow-up \(1\)/.test(plain),
    );
    await fsPromises.writeFile(capturePath, pane.plain);

    assert.match(pane.plain, /Steer/);
    assert.match(pane.plain, /Follow-up/);
    assert.match(pane.plain, /steer now/);
    assert.match(pane.plain, /follow later/);
    assert.match(pane.plain, /Esc->send now/);
    assert.match(pane.plain, /Ctrl\+U,S->edit/);
    assert.match(pane.plain, /Ctrl\+U,F->edit/);

    // Ctrl+U alone only arms the dual-queue choice.
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "C-u"]);
    const armed = await waitForPane(tmux, label, session, (plain) =>
      /S: Steer.*F: Follow-up.*Esc: cancel/.test(plain),
    );
    assert.match(armed.plain, /Steer \(1\)[\s\S]*steer now/);
    assert.match(armed.plain, /Follow-up \(1\)[\s\S]*follow later/);

    await tmuxRun(tmux, label, ["send-keys", "-t", session, "Escape"]);
    const canceled = await waitForPane(
      tmux,
      label,
      session,
      (plain) =>
        /Queue edit canceled/.test(plain) &&
        /Steer \(1\)[\s\S]*steer now/.test(plain) &&
        /Follow-up \(1\)[\s\S]*follow later/.test(plain),
    );
    assert.match(canceled.plain, /Queue edit canceled/);

    // F edits Follow-up and leaves Steer queued.
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "C-u", "f"]);
    const afterFollowUpEdit = await waitForPane(
      tmux,
      label,
      session,
      (plain) => /Steer \(1\)[\s\S]*steer now/.test(plain) && !/Follow-up \(1\)/.test(plain),
    );
    assert.match(afterFollowUpEdit.plain, /follow later/);

    // Recreate a Follow-up, then S edits Steer and preserves Follow-up.
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "C-c"]);
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "-l", "/follow-up follow again"]);
    await waitForPane(tmux, label, session, (plain) => /\/follow-up follow again/.test(plain));
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "Enter"]);
    await waitForPane(
      tmux,
      label,
      session,
      (plain) => /Steer \(1\)/.test(plain) && /Follow-up \(1\)[\s\S]*follow again/.test(plain),
    );
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "C-u", "s"]);
    const afterSteerEdit = await waitForPane(
      tmux,
      label,
      session,
      (plain) => !/Steer \(1\)/.test(plain) && /Follow-up \(1\)[\s\S]*follow again/.test(plain),
    );
    assert.match(afterSteerEdit.plain, /steer now/);

    // Recreate Steer and verify Esc still flushes only Steer.
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "C-c"]);
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "-l", "steer again"]);
    await waitForPane(tmux, label, session, (plain) => /steer again/.test(plain));
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "Enter"]);
    await waitForPane(
      tmux,
      label,
      session,
      (plain) => /Steer \(1\)[\s\S]*steer again/.test(plain) && /Follow-up \(1\)/.test(plain),
    );
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "Escape"]);
    const afterEsc = await waitForPane(
      tmux,
      label,
      session,
      (plain) =>
        /Follow-up \(1\)[\s\S]*follow again/.test(plain) && !/Steer \(1\)/.test(plain),
    );
    assert.match(afterEsc.plain, /Follow-up \(1\)[\s\S]*follow again/);

    // Release the blocked tool so follow-up can deliver after idle.
    await fsPromises.writeFile(path.join(dir, "release"), "1");
    const idleDeadline = Date.now() + 15_000;
    let idleOk = false;
    while (Date.now() < idleDeadline) {
      try {
        const idle = JSON.parse(await fsPromises.readFile(path.join(dir, "idle.json"), "utf8")) as {
          pendingFollowUps: string[];
        };
        if (Array.isArray(idle.pendingFollowUps) && idle.pendingFollowUps.length === 0) {
          idleOk = true;
          break;
        }
      } catch {
        // not yet
      }
      await delay(150);
    }
    assert.equal(idleOk, true, "follow-up should be consumed after turn ends");
  } finally {
    await tmuxRun(tmux, label, ["kill-session", "-t", session]).catch(() => undefined);
    // Safe: isolated socket only.
    await tmuxRun(tmux, label, ["kill-server"]).catch(() => undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

async function resolveTmux(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["tmux"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    throw new Error("tmux is required for MIXCODE_RUN_TMUX_FOLLOWUP=1");
  }
}

async function tmuxRun(
  tmux: string,
  label: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tmux, ["-L", label, ...args], { encoding: "utf8" });
}

async function capturePane(
  tmux: string,
  label: string,
  session: string,
): Promise<{ ansi: string; plain: string }> {
  const { stdout } = await tmuxRun(tmux, label, ["capture-pane", "-p", "-e", "-t", session]);
  return { ansi: stdout, plain: stripAnsi(stdout) };
}

async function waitForPane(
  tmux: string,
  label: string,
  session: string,
  matches: (plain: string) => boolean,
  timeoutMs = 5_000,
): Promise<{ ansi: string; plain: string }> {
  const deadline = Date.now() + timeoutMs;
  let pane = await capturePane(tmux, label, session);
  while (Date.now() < deadline) {
    if (matches(pane.plain)) return pane;
    await delay(100);
    pane = await capturePane(tmux, label, session);
  }
  assert.fail(`timed out waiting for pane state:\n${pane.plain}`);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(ms: number): Promise<void> {
  return Bun.sleep(ms);
}
