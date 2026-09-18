import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import { FollowUpCleanup } from "./helpers/follow-up-cleanup.js";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime } from "./helpers/mixcode.js";
import { testTui } from "./helpers/tui.js";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "follow-up-boundary-"));
  const commands: string[] = [];
  await Bun.write(path.join(dir, ".pi/prompts/boundary-template.md"), "Template argument: $1");
  await Bun.write(
    path.join(dir, ".agents/skills/boundary-skill/SKILL.md"),
    "---\nname: boundary-skill\ndescription: Test skill boundary\n---\nSkill boundary instructions.\n",
  );
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    extensionFactories: [
      (pi) => {
        pi.registerCommand("boundary-demo", {
          description: "Record command arguments",
          handler: async (args) => {
            commands.push(args);
          },
        });
      },
    ],
  });
  const state = createInitialState(dir);
  const tab = createTab(1, "boundary", dir);
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtimeTab = await runtime.createTab(tab, {
    model: MIXCODE_FAUX_MODEL,
    workdir: dir,
    systemPrompt: "system",
    thinkingLevel: "off",
  });
  tab.followUpsPaused = true;
  const cleanup = new FollowUpCleanup(runtime, dir);
  return {
    dir,
    commands,
    runtime,
    runtimeTab,
    tab,
    state,
    async cleanup() {
      await cleanup.cleanup();
    },
  };
}

test("extension commands separate ordinary follow-up batches at the head and middle", async () => {
  const f = await fixture();
  try {
    for (const text of ["/boundary-demo first", "A", "B", "/boundary-demo second", "C"]) {
      await handleSubmittedInput(f.state, f.runtime, `/follow-up ${text}`, testTui());
    }
    await f.runtime.resumeFollowUps(f.tab.sessionId);
    assert.deepEqual(f.commands, ["first", "second"]);
    assert.deepEqual(
      f.runtimeTab.chat.filter((line) => line.role === "user").map((line) => line.text),
      ["A\n\nB", "C"],
    );
  } finally {
    await f.cleanup();
  }
});

test("skills and templates expand separately from adjacent follow-up text", async () => {
  const f = await fixture();
  try {
    for (const text of [
      "/boundary-template value",
      "ordinary",
      "/skill:boundary-skill task",
      "after skill",
    ]) {
      await f.runtime.prompt(f.tab.sessionId, text, { streamingBehavior: "followUp" });
    }
    await f.runtime.resumeFollowUps(f.tab.sessionId);
    const users = f.runtimeTab.chat.filter((line) => line.role === "user").map((line) => line.text);
    assert.equal(users[0], "Template argument: value");
    assert.equal(users[1], "ordinary");
    assert.match(users[2]!, /Skill boundary instructions/);
    assert.match(users[2]!, /task/);
    assert.equal(users[3], "after skill");
    assert.equal(users.length, 4);
  } finally {
    await f.cleanup();
  }
});

test("clearing a queued conversation discards its remaining tasks", async () => {
  const f = await fixture();
  try {
    await f.runtime.queueFollowUpCommand(f.tab.sessionId, "/clear", async () => {
      await f.runtime.clearTab(f.tab.sessionId, {
        workdir: f.dir,
        systemPrompt: "system",
        thinkingLevel: "off",
        model: MIXCODE_FAUX_MODEL,
      });
    });
    await f.runtime.prompt(f.tab.sessionId, "must not run", {
      streamingBehavior: "followUp",
      followUpNext: true,
    });
    await f.runtime.resumeFollowUps(f.tab.sessionId);
    assert.deepEqual(f.tab.followUpQueue, []);
    const newTab = f.runtime.getTab(f.tab.sessionId)!;
    assert.deepEqual(
      newTab.chat.filter((line) => line.role === "user"),
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test("queued reload hands remaining work to the new session exactly once", async () => {
  const f = await fixture();
  try {
    const oldSession = f.runtimeTab.agentSession;
    await handleSubmittedInput(f.state, f.runtime, "/follow-up-next /reload", testTui());
    await handleSubmittedInput(f.state, f.runtime, "/follow-up-next after reload", testTui());
    await f.runtime.resumeFollowUps(f.tab.sessionId);
    assert.notEqual(f.runtimeTab.agentSession, oldSession);
    assert.deepEqual(
      f.runtimeTab.chat.filter((line) => line.role === "user").map((line) => line.text),
      ["after reload"],
    );
    assert.deepEqual(f.tab.pendingFollowUps, []);
  } finally {
    await f.cleanup();
  }
});

test("queued workdir change hands the queue over without replay", async () => {
  const f = await fixture();
  try {
    const nextDir = path.join(f.dir, "next");
    await fs.mkdir(nextDir);
    await f.runtime.queueFollowUpCommand(f.tab.sessionId, `/workdir ${nextDir}`, () =>
      f.runtime.updateTabWorkdir(f.tab.sessionId, nextDir, "system"),
    );
    await f.runtime.prompt(f.tab.sessionId, "after workdir", {
      streamingBehavior: "followUp",
      followUpNext: true,
    });
    await f.runtime.resumeFollowUps(f.tab.sessionId);
    assert.equal(f.tab.workdir, nextDir);
    assert.deepEqual(
      f.runtimeTab.chat.filter((line) => line.role === "user").map((line) => line.text),
      ["after workdir"],
    );
  } finally {
    await f.cleanup();
  }
});
