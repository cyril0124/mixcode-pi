import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const repo = resolve(".");
  const dir = await mkdtemp(join(tmpdir(), "mixcode-followup-tmux-"));
  // Isolated socket label — never use default socket kill-server.
  const label = `mixcode-followup-${process.pid}-${Date.now()}`;
  const session = "followup";
  const marker = join(dir, "ready.json");
  const capturePath = join(dir, "pane.txt");

  try {
    const harness = resolve(repo, "test/follow-up-tui-harness.ts");
    const cmd = [
      `MIXCODE_FOLLOWUP_HARNESS_DIR=${shellQuote(dir)}`,
      `MIXCODE_FOLLOWUP_MARKER=${shellQuote(marker)}`,
      `npx tsx ${shellQuote(harness)}`,
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
        const raw = await readFile(marker, "utf8");
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

    // Give the TUI a frame to paint queue boxes.
    await delay(500);
    const pane = await capturePane(tmux, label, session);
    await writeFile(capturePath, pane.plain);

    assert.match(pane.plain, /Steer/);
    assert.match(pane.plain, /Follow-up/);
    assert.match(pane.plain, /steer now/);
    assert.match(pane.plain, /follow later/);
    assert.match(pane.plain, /Esc->send now/);

    // Esc should flush steer only — send Escape and re-check Follow-up remains.
    await tmuxRun(tmux, label, ["send-keys", "-t", session, "Escape"]);
    await delay(1200);
    const afterEsc = await capturePane(tmux, label, session);
    assert.match(afterEsc.plain, /Follow-up|follow later/, "follow-up should survive Esc flush");
    // Steer preview text should be gone (flushed or no longer queued).
    assert.doesNotMatch(
      afterEsc.plain,
      /Steer \(1\)[\s\S]*steer now/,
      "steer queue preview should clear after Esc flush",
    );

    // Release the blocked tool so follow-up can deliver after idle.
    await writeFile(join(dir, "release"), "1");
    const idleDeadline = Date.now() + 15_000;
    let idleOk = false;
    while (Date.now() < idleDeadline) {
      try {
        const idle = JSON.parse(await readFile(join(dir, "idle.json"), "utf8")) as {
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
    await rm(dir, { recursive: true, force: true });
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
