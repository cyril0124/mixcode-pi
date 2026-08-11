import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("tmux TUI smoke covers max thinking, theme, navigation, and exit", {
  skip:
    process.env.MIXCODE_RUN_TMUX_TUI_SMOKE !== "1"
      ? "set MIXCODE_RUN_TMUX_TUI_SMOKE=1 to run a real tmux TUI smoke"
      : false,
}, async () => {
  const tmux = await resolveTmux();
  const repo = path.resolve(".");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-tmux-smoke-"));
  const session = `mixcode-tmux-smoke-${process.pid}-${Date.now()}`;
  try {
    const workdir = path.join(dir, "workdir");
    const configHome = path.join(dir, "xdg");
    const agentDir = path.join(dir, "agent");
    await fsPromises.mkdir(workdir, { recursive: true });
    await fsPromises.mkdir(configHome, { recursive: true });
    await fsPromises.mkdir(agentDir, { recursive: true });
    await fsPromises.writeFile(path.join(workdir, "probe.txt"), "probe\n");
    await fsPromises.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          smoke: {
            baseUrl: "https://smoke.invalid/v1",
            api: "openai",
            apiKey: "MIXCODE_TUI_SMOKE_KEY",
            models: [
              {
                id: "max-model",
                reasoning: true,
                contextWindow: 200_000,
                maxTokens: 1,
                input: ["text"],
                thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", max: "max" },
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );

    await tmuxRun(tmux, session, [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "180",
      "-y",
      "48",
      "-c",
      repo,
      `XDG_CONFIG_HOME=${shellQuote(configHome)} MIXCODE_CODING_AGENT_DIR=${shellQuote(agentDir)} PI_CODING_AGENT_DIR=${shellQuote(agentDir)} MIXCODE_TUI_SMOKE_KEY=smoke ./run.sh --workdir ${shellQuote(workdir)}`,
    ]);

    const initial = await waitForPane(tmux, session, /MixCode/, 25_000);
    assert.match(initial.plain, /MixCode/);
    assert.match(initial.plain, /MixCode Home/);
    assert.match(initial.plain, /Agent-01/);
    assert.doesNotMatch(initial.plain, /OpenCode|Attach Session|Connect|Reconnect/);

    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Tab"]);
    const agent = await waitForPane(tmux, session, /Send message to Agent-01[\s\S]*smoke\/max-model/, 5_000);
    assert.match(agent.plain, /smoke\/max-model/);

    await sendLiteral(tmux, session, "/thinking");
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Enter"]);
    const thinkingPicker = await waitForPane(tmux, session, /Choose Thinking[\s\S]*max/, 5_000);
    assert.match(thinkingPicker.plain, /Choose Thinking/);
    assert.match(thinkingPicker.plain, /max/);
    await sendEscape(tmux, session);

    await sendLiteral(tmux, session, "/thinking max");
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Enter"]);
    const maxThinking = await waitForPane(tmux, session, /smoke\/max-model[\s\S]*Max/, 5_000);
    assert.match(maxThinking.plain, /smoke\/max-model[\s\S]*Max/);

    // Theme is edited via /settings (not /theme). Select rows by their visible
    // labels so adding unrelated settings cannot redirect this keyboard flow.
    await delay(400);
    await tmuxRun(tmux, session, ["send-keys", "-l", "-t", session, "/settings"]);
    await delay(400);
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Enter"]);
    await waitForPane(tmux, session, /Settings[\s\S]*Theme/, 5_000);
    await selectRowByLabel(tmux, session, "Theme");
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Enter"]);
    await delay(200);
    await selectRowByLabel(tmux, session, "tokyo-night");
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Enter"]);
    await delay(400);
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Escape"]);
    await delay(400);

    const themed = await capturePane(tmux, session);
    assert.equal(themed.ansi.includes("\x1b[48;2;51;70;124m"), true);

    await sendLiteral(tmux, session, "\x10");
    const palette = await waitForPane(tmux, session, /Command Palette[\s\S]*Choose Model/, 5_000);
    assert.match(palette.plain, /Command Palette/);
    await sendEscape(tmux, session);

    await sendLiteral(tmux, session, "\x14");
    const tabJump = await waitForPane(tmux, session, /Tab Jump[\s\S]*Agent-01/, 5_000);
    assert.match(tabJump.plain, /Tab Jump/);
    await sendEscape(tmux, session);

    await sendLiteral(tmux, session, "/new-session Smoke");
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Enter"]);
    const twoTabs = await waitForPane(tmux, session, /^ MixCode Home.*Agent-01.*Smoke/m, 5_000);
    assert.match(twoTabs.plain, /Send message to Smoke/);
    await sendSgrMouse(tmux, session, 20, 1);
    await delay(300);
    const clickedTab = await capturePane(tmux, session);
    assert.match(clickedTab.plain, /Send message to Agent-01/);

    await tmuxRun(tmux, session, ["send-keys", "-t", session, "C-q"]);
    await delay(200);
    const quit = await capturePane(tmux, session);
    assert.match(quit.plain, /Quit/);
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "y"]);
    await delay(500);
    await assert.rejects(() => tmuxRun(tmux, session, ["has-session", "-t", session]));
  } finally {
    await tmuxRun(tmux, session, ["kill-session", "-t", session]).catch(() => undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

async function resolveTmux(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["tmux"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    throw new Error("tmux is required for MIXCODE_RUN_TMUX_TUI_SMOKE=1");
  }
}

async function sendLiteral(tmux: string, session: string, data: string): Promise<void> {
  await tmuxRun(tmux, session, ["send-keys", "-l", "-t", session, data]);
  await delay(300);
}

async function sendEscape(tmux: string, session: string): Promise<void> {
  await tmuxRun(tmux, session, ["send-keys", "-t", session, "Escape"]);
  await delay(300);
}

async function sendSgrMouse(tmux: string, session: string, x: number, y: number): Promise<void> {
  await sendLiteral(tmux, session, `\x1b[<0;${x};${y}M`);
}

async function tmuxRun(
  tmux: string,
  session: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tmux, ["-L", session, ...args], { encoding: "utf8" });
}

async function capturePane(
  tmux: string,
  session: string,
): Promise<{ ansi: string; plain: string }> {
  const { stdout } = await tmuxRun(tmux, session, ["capture-pane", "-p", "-e", "-t", session]);
  return { ansi: stdout, plain: stripAnsi(stdout) };
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

async function selectRowByLabel(tmux: string, session: string, label: string): Promise<void> {
  const seen = new Set<string>();
  for (;;) {
    const pane = await capturePane(tmux, session);
    const selected = pane.plain.split("\n").filter((line) => line.includes("› "));
    if (selected.some((line) => line.includes(label))) return;
    const selectionState = selected.join("\n");
    if (!selectionState || seen.has(selectionState)) {
      throw new Error(`Could not select TUI row: ${label}`);
    }
    seen.add(selectionState);
    await tmuxRun(tmux, session, ["send-keys", "-t", session, "Down"]);
    await delay(80);
  }
}

async function waitForPane(
  tmux: string,
  session: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ ansi: string; plain: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = await capturePane(tmux, session);
  while (Date.now() < deadline) {
    if (pattern.test(last.plain)) return last;
    await delay(250);
    last = await capturePane(tmux, session);
  }
  assert.match(last.plain, pattern);
  return last;
}
