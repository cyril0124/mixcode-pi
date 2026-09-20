import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools, Type } from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL, mixcodeFauxStream } from "../src/agent/faux-stream.js";
import { createTab, MixCodeRuntime } from "./helpers/mixcode.js";

async function fixture(t: TestContext, extension: ExtensionFactory) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-prompt-transcript-"));
  const requests: Array<{ prompt: string; tools: string[] }> = [];
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir: path.join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    extensionFactories: [extension],
    streamFn: (model, context, options) => {
      requests.push({
        prompt: getCurrentSystemPrompt(context.messages),
        tools: getCurrentTools(context.messages)
          .map((tool) => tool.name)
          .sort(),
      });
      return mixcodeFauxStream(model, context, options);
    },
  });
  const tab = await runtime.createTab(createTab(1, "s1", dir), {
    model: {
      ...MIXCODE_FAUX_MODEL,
      provider: "prompt-transcript-test",
      api: "prompt-transcript-test",
    },
    systemPrompt: "HOST-IDENTITY",
    thinkingLevel: "off",
    workdir: dir,
  });
  t.after(async () => {
    tab.agentSession.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, runtime, tab, requests };
}

test("host prompt changes and tool declarations survive transcript reload", async (t) => {
  const hookPrompts: string[] = [];
  const { runtime, tab, requests } = await fixture(t, (pi) => {
    pi.registerTool({
      name: "inspect_marker",
      label: "Inspect marker",
      description: "Inspect the marker",
      parameters: Type.Object({}),
      promptGuidelines: ["Inspect the marker before making changes."],
      execute: async () => ({ content: [{ type: "text", text: "marker" }], details: {} }),
    });
    pi.on("before_agent_start", (event) => {
      hookPrompts.push(event.systemPrompt);
      event.systemPromptOptions.sections.phase = event.prompt;
    });
  });
  await runtime.prompt("s1", "phase one");
  tab.agentSession.setActiveToolsByName(["read"]);
  await runtime.prompt("s1", "phase two");

  assert.match(hookPrompts[0]!, /HOST-IDENTITY/);
  assert.match(hookPrompts[0]!, /Current date:/);
  assert.match(requests[0]!.prompt, /Inspect the marker before making changes\./);
  assert.match(requests[0]!.prompt, /<phase>\nphase one\n<\/phase>/);
  assert.match(requests[1]!.prompt, /<phase>\nphase two\n<\/phase>/);
  assert.doesNotMatch(requests[1]!.prompt, /Inspect the marker before making changes\./);
  assert.deepEqual(requests[1]!.tools, ["read"]);

  const file = tab.agentSession.sessionFile;
  assert.ok(file);
  const restored = SessionManager.open(file).buildSessionContext().messages;
  assert.equal(getCurrentSystemPrompt(restored), requests[1]!.prompt);
  assert.deepEqual(
    getCurrentTools(restored).map((tool) => tool.name),
    ["read"],
  );
});

test("extension forced prompt overrides the host for one run without replacing persisted instructions", async (t) => {
  const { runtime, tab, requests } = await fixture(t, (pi) => {
    pi.on("before_agent_start", (event) => {
      if (event.prompt === "force") return { systemPrompt: "EXACT-FORCED-PROMPT" };
    });
  });
  await runtime.prompt("s1", "force");
  assert.equal(requests[0]!.prompt, "EXACT-FORCED-PROMPT");
  assert.ok(requests[0]!.tools.includes("read"));
  assert.match(getCurrentSystemPrompt(tab.agentSession.messages), /HOST-IDENTITY/);
  await runtime.prompt("s1", "normal");
  assert.match(requests[1]!.prompt, /HOST-IDENTITY/);
  assert.doesNotMatch(requests[1]!.prompt, /EXACT-FORCED-PROMPT/);
});
