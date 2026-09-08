import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";

const sessionPath =
  "/home/example/.pi/agent/sessions/--workspace-project--/2025-01-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl";

async function withSlashRuntime(
  run: (runtime: MixCodeRuntime, dir: string) => Promise<void>,
  extensionFactories: ExtensionFactory[] = [],
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-slash-input-"));
  const agentDir = path.join(dir, "agent");
  await Bun.write(path.join(agentDir, "prompts", "route-template.md"), "Expanded $1\n$2");
  await Bun.write(
    path.join(agentDir, "skills", "route-skill", "SKILL.md"),
    "---\nname: route-skill\ndescription: Routing test skill.\n---\nUse the routing fixture.\n",
  );
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    extensionFactories,
  });
  try {
    await run(runtime, dir);
  } finally {
    await runtime.closeAllTabs();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const tui = {
  requestRender() {},
  showOverlay(): never {
    throw new Error("Unexpected overlay during slash input submission");
  },
};

test("TUI submits paths and unknown slash input as complete user messages", async () => {
  await withSlashRuntime(async (runtime, dir) => {
    const state = createInitialState(dir);
    const tab = createTab(1, "slash-input", dir);
    state.tabs.push(tab);
    state.activeTabId = tab.sessionId;
    const runtimeTab = await runtime.createTab(tab, { model: MIXCODE_FAUX_MODEL, workdir: dir });
    const inputs = [
      sessionPath,
      "/models/file",
      "/",
      "/unknown first line\n  second line\nthird line",
      `  ${sessionPath}\nExplain this session.`,
    ];
    for (const input of inputs) {
      await handleSubmittedInput(state, runtime, input, tui);
    }
    assert.deepEqual(
      runtimeTab.agentSession.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
      inputs.map((input) => [{ type: "text", text: input.trimStart() }]),
    );
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "assistant").map((line) => line.text),
      inputs.map((input) => `Echo: ${input.trimStart()}`),
    );
    assert.equal(state.activeTabId, tab.sessionId);
  });
});

test("TUI preserves Pi command, input interception, and expansion order", async () => {
  const commands: string[] = [];
  const inputs: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("route-command", {
      handler: async (args) => {
        commands.push(args);
      },
    });
    pi.on("input", (event) => {
      inputs.push(event.text);
      if (event.text === "/route-intercept") return { action: "handled" };
      if (event.text === "/route-rewrite") {
        return { action: "transform", text: '/route-template "first line" "second line"' };
      }
      return { action: "continue" };
    });
  };
  await withSlashRuntime(
    async (runtime, dir) => {
      const state = createInitialState(dir);
      const tab = createTab(1, "slash-pipeline", dir);
      state.tabs.push(tab);
      state.activeTabId = tab.sessionId;
      const runtimeTab = await runtime.createTab(tab, { model: MIXCODE_FAUX_MODEL, workdir: dir });

      await handleSubmittedInput(state, runtime, "  /route-command first\n  second", tui);
      assert.deepEqual(commands, ["first\n  second"]);
      assert.deepEqual(inputs, []);
      assert.deepEqual([...runtimeTab.agentSession.messages], []);

      await handleSubmittedInput(state, runtime, "/route-intercept", tui);
      assert.deepEqual(inputs, ["/route-intercept"]);
      assert.deepEqual([...runtimeTab.agentSession.messages], []);

      await handleSubmittedInput(state, runtime, "/route-rewrite", tui);
      await handleSubmittedInput(state, runtime, "/route-template direct value", tui);
      await handleSubmittedInput(state, runtime, "/skill:route-skill user detail", tui);
      assert.deepEqual(inputs, [
        "/route-intercept",
        "/route-rewrite",
        "/route-template direct value",
        "/skill:route-skill user detail",
      ]);
      const messages = runtimeTab.agentSession.messages.filter(
        (message) => message.role === "user",
      );
      assert.deepEqual(
        messages.slice(0, 2).map((message) => message.content),
        [
          [{ type: "text", text: "Expanded first line\nsecond line" }],
          [{ type: "text", text: "Expanded direct\nvalue" }],
        ],
      );
      const skillText = messages[2]?.content;
      assert.ok(Array.isArray(skillText));
      const text = skillText.find((block) => block.type === "text")?.text ?? "";
      assert.match(text, /<skill name="route-skill"/);
      assert.match(text, /Use the routing fixture\./);
      assert.match(text, /user detail/);
    },
    [extension],
  );
});

test("registered MixCode commands retain priority over extension commands", async () => {
  const commands: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("rename", {
      handler: async (args) => {
        commands.push(args);
      },
    });
  };
  await withSlashRuntime(
    async (runtime, dir) => {
      const state = createInitialState(dir);
      const tab = createTab(1, "slash-local", dir);
      state.tabs.push(tab);
      state.activeTabId = tab.sessionId;
      const runtimeTab = await runtime.createTab(tab, { model: MIXCODE_FAUX_MODEL, workdir: dir });
      await handleSubmittedInput(state, runtime, "/rename local title", tui);
      assert.equal(runtimeTab.session.getSessionName(), "local title");
      assert.deepEqual(commands, []);
      assert.deepEqual(runtimeTab.agentSession.messages, []);
    },
    [extension],
  );
});
