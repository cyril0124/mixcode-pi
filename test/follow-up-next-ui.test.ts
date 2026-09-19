import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseInput } from "../src/core/commands.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeState, MixCodeTabInfo } from "../src/core/types.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import { renderQueuePreview } from "../src/ui/rendering/agent-surface.js";
import { FollowUpCleanup } from "./helpers/follow-up-cleanup.js";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime } from "./helpers/mixcode.js";
import { testTui } from "./helpers/tui.js";

function queuedTab() {
  return createTab(1, "queue-preview", "/repo", {
    followUpQueue: [
      { text: "batch A", kind: "batch" },
      { text: "batch B", kind: "batch" },
      { text: "exclusive C", kind: "next" },
      { text: "batch D", kind: "batch" },
      { text: "exclusive E", kind: "next" },
    ],
    pendingFollowUps: ["batch A", "batch B", "exclusive C", "batch D", "exclusive E"],
  });
}

test("follow-up-next parses both a queued message and an explicit resume", () => {
  assert.deepEqual(parseInput("/follow-up-next test the result"), {
    kind: "local-command",
    command: "follow-up-next",
    args: "test the result",
  });
  assert.deepEqual(parseInput("/follow-up-next"), {
    kind: "local-command",
    command: "follow-up-next",
    args: "",
  });
});

test("queue preview groups adjacent batch messages and isolates next messages in FIFO rounds", () => {
  const preview = stripAnsi(renderQueuePreview(queuedTab(), 100).join("\n"));
  assert.match(preview, /Follow-up \(5\)/);
  assert.match(preview, /Round 1 · batch A/);
  assert.match(preview, /Round 1 · batch B/);
  assert.match(preview, /Round 2 · next · exclusive C/);
  assert.match(preview, /Round 3 · batch D/);
  assert.match(preview, /Round 4 · next · exclusive E/);
  assert.doesNotMatch(preview, /Paused|resume/);
});

test("paused queue advertises explicit resume separately from queue editing", () => {
  const tab = queuedTab();
  tab.followUpsPaused = true;
  tab.pendingMessages = ["steer now"];
  const lines = renderQueuePreview(tab, 46);
  const preview = stripAnsi(lines.join("\n"));
  const followBlock = preview.slice(preview.indexOf("Follow-up"));
  assert.match(followBlock, /Paused/);
  assert.match(followBlock, /\/follow-up-next to resume/);
  assert.match(followBlock, /Ctrl\+U,F->edit/);
  assert.doesNotMatch(followBlock, /Esc->send now/);
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 46),
    true,
  );
});

test("latest queue preview preserves round numbers and separates SDK follow-ups", () => {
  const tab = queuedTab();
  tab.followUpQueue.push({ text: "exclusive F", kind: "next" });
  tab.pendingFollowUps.push("exclusive F", "extension companion");
  const preview = stripAnsi(renderQueuePreview(tab, 100).join("\n"));
  assert.match(preview, /Follow-up \(7, latest 5\)/);
  assert.doesNotMatch(preview, /batch A|batch B/);
  assert.match(preview, /Round 2 · next · exclusive C/);
  assert.match(preview, /Round 5 · next · exclusive F/);
  assert.match(preview, /SDK · extension companion/);
  assert.doesNotMatch(preview, /Round \d+[^\n]*extension companion/);
});

async function withRuntime(
  run: (context: {
    runtime: MixCodeRuntime;
    state: MixCodeState;
    tab: MixCodeTabInfo;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-up-next-ui-"));
  const runtime = new MixCodeRuntime({ sessionsRoot: dir });
  const cleanup = new FollowUpCleanup(runtime, dir);
  try {
    const state = createInitialState(dir);
    const tab = createTab(1, "ui-follow-up", dir);
    state.tabs.push(tab);
    state.activeTabId = tab.sessionId;
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });
    await run({ runtime, state, tab });
  } finally {
    await cleanup.cleanup();
  }
}

test("follow-up commands preserve batch/next boundaries while paused and Ctrl+U restores next intent", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    tab.followUpsPaused = true;
    const tui = testTui();
    await handleSubmittedInput(state, runtime, "/follow-up batch A", tui);
    await handleSubmittedInput(state, runtime, "/follow-up-next exclusive B", tui);
    assert.deepEqual(tab.followUpQueue, [
      { text: "batch A", kind: "batch" },
      { text: "exclusive B", kind: "next" },
    ]);
    assert.equal(tab.followUpsPaused, true);
    let editorText = "";
    handleMixCodeKeyInput(state, "\x15", tui, undefined, runtime, undefined, () => false, {
      getText: () => editorText,
      setText: (text) => {
        editorText = text;
      },
    });
    assert.equal(editorText, "/follow-up-next exclusive B");
    assert.deepEqual(tab.pendingFollowUps, ["batch A"]);
  });
});

test("Alt+Enter appends a batch follow-up while idle and paused", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    tab.followUpsPaused = true;
    let editorText = "queued with Alt+Enter";
    const queued = Promise.withResolvers<void>();
    const unsubscribe = runtime.onChange(() => {
      if (tab.pendingFollowUps.includes("queued with Alt+Enter")) queued.resolve();
    });
    try {
      handleMixCodeKeyInput(
        state,
        "\x1b\r",
        testTui(),
        undefined,
        runtime,
        undefined,
        () => false,
        {
          getText: () => editorText,
          setText: (text) => {
            editorText = text;
          },
          submitCurrentText: () => {
            throw new Error("Paused Alt+Enter must not start an ordinary turn");
          },
        },
      );
      await queued.promise;
      assert.deepEqual(tab.followUpQueue, [{ text: "queued with Alt+Enter", kind: "batch" }]);
      assert.equal(tab.followUpsPaused, true);
      assert.equal(editorText, "");
    } finally {
      unsubscribe();
    }
  });
});

test("follow-up-next without arguments resumes a paused queue through command submission", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up-next resumed text", testTui());
    await handleSubmittedInput(state, runtime, "/follow-up-next", testTui());
    const runtimeTab = runtime.getTab(tab.sessionId)!;
    await runtimeTab.agentSession.waitForIdle();
    assert.equal(tab.followUpsPaused, false);
    assert.deepEqual(tab.pendingFollowUps, []);
    assert.equal(
      runtimeTab.chat.some((line) => line.role === "user" && line.text === "resumed text"),
      true,
    );
  });
});

test("follow-up-next without queued messages surfaces its user-facing error", async () => {
  await withRuntime(async ({ runtime, state }) => {
    await assert.rejects(
      handleSubmittedInput(state, runtime, "/follow-up-next", testTui()),
      /Error: No follow-up messages to resume/,
    );
  });
});

test("queued local slash command runs on its owning tab without sending model text", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    const runtimeTab = runtime.getTab(tab.sessionId)!;
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up-next /color red", testTui());
    assert.equal(tab.color, undefined);
    const other = createTab(2, "other-tab", tab.workdir);
    state.tabs.push(other);
    state.activeTabId = other.sessionId;
    await runtime.resumeFollowUps(tab.sessionId);
    assert.equal(tab.color, "red");
    assert.equal(other.color, undefined);
    assert.deepEqual(
      runtimeTab.session.getBranch().filter((entry) => entry.type === "message"),
      [],
    );
    assert.deepEqual(tab.pendingFollowUps, []);
  });
});

test("queued slash commands retain FIFO order and thrown command errors pause remaining tasks", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /color red", testTui());
    await handleSubmittedInput(state, runtime, "/follow-up-next /follow-up", testTui());
    await handleSubmittedInput(state, runtime, "/follow-up /color blue", testTui());
    await assert.rejects(runtime.resumeFollowUps(tab.sessionId), /Error: Usage: \/follow-up/);
    assert.equal(tab.color, "red");
    assert.equal(tab.followUpsPaused, true);
    assert.deepEqual(tab.pendingFollowUps, ["/color blue"]);
    await runtime.resumeFollowUps(tab.sessionId);
    assert.equal(tab.color, "blue");
    assert.deepEqual(tab.pendingFollowUps, []);
    assert.deepEqual(
      runtime
        .getTab(tab.sessionId)!
        .session.getBranch()
        .filter((entry) => entry.type === "message"),
      [],
    );
  });
});

test("ordinary follow-up commands separate text batches and retain their prefix when edited", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up before", testTui());
    await handleSubmittedInput(state, runtime, "/follow-up /color red", testTui());
    await handleSubmittedInput(state, runtime, "/follow-up after", testTui());
    const preview = stripAnsi(renderQueuePreview(tab, 100).join("\n"));
    assert.match(preview, /Round 1 · before/);
    assert.match(preview, /Round 2 · command · \/color red/);
    assert.match(preview, /Round 3 · after/);
    await runtime.resumeFollowUps(tab.sessionId);
    assert.equal(tab.color, "red");
    assert.deepEqual(
      runtime
        .getTab(tab.sessionId)!
        .chat.filter((line) => line.role === "user")
        .map((line) => line.text),
      ["before", "after"],
    );
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /color blue", testTui());
    assert.equal(runtime.popPendingMessage(tab.sessionId, "followUp"), "/follow-up /color blue");
    assert.deepEqual(tab.pendingFollowUps, []);
  });
});

test("both follow-up-next forms reject a disabled model without changing the paused queue", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up-next retained text", testTui());
    tab.model.disabled = true;
    for (const command of ["/follow-up-next", "/follow-up-next another text"]) {
      await assert.rejects(
        handleSubmittedInput(state, runtime, command, testTui()),
        /Model is disabled/,
      );
      assert.deepEqual(tab.pendingFollowUps, ["retained text"]);
      assert.equal(tab.followUpsPaused, true);
    }
  });
});
