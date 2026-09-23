import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  Type,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL, mixcodeFauxStream } from "../src/agent/faux-stream.js";
import { createTab, MixCodeRuntime } from "./helpers/mixcode.js";
import type { MixCodeStreamFn } from "../src/agent/runtime-types.js";
import { getEffectiveSystemPrompt } from "../src/agent/pi-session-internals.js";

async function fixture(
  t: TestContext,
  extension: ExtensionFactory,
  stream: MixCodeStreamFn = mixcodeFauxStream,
) {
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
      return stream(model, context, options);
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
    await runtime.closeAllTabs();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, runtime, tab, requests };
}

function promptUpdates(manager: SessionManager, offset = 0): SystemMessage[] {
  return manager
    .getEntries()
    .slice(offset)
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
    );
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

test("one extension section changes without repeating the host prompt", async (t) => {
  let phase = "one";
  const { runtime, tab, requests } = await fixture(t, (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.phase = phase;
    });
  });
  await runtime.prompt("s1", "first");
  const firstLeaf = tab.session.getLeafId();
  const firstEntries = structuredClone(tab.session.getEntries());
  phase = "two";
  await runtime.prompt("s1", "second");
  const updates = promptUpdates(tab.session, firstEntries.length);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.sections, { extensions: "<phase>\ntwo\n</phase>" });
  assert.equal(updates[0]?.content, "");
  assert.deepEqual(tab.session.getEntries().slice(0, firstEntries.length), firstEntries);
  assert.ok(firstLeaf);
  const file = tab.agentSession.sessionFile;
  assert.ok(file);
  const reopened = SessionManager.open(file);
  assert.equal(
    getCurrentSystemPrompt(reopened.buildSessionContext().messages),
    requests[1]!.prompt,
  );
  reopened.branch(firstLeaf);
  assert.equal(
    getCurrentSystemPrompt(reopened.buildSessionContext().messages),
    requests[0]!.prompt,
  );
});

test("optional sections can appear, disappear and return without changing replay order", async (t) => {
  let add = false;
  let expectedPrompt = "";
  const { runtime, tab, requests } = await fixture(t, (pi) => {
    pi.on("before_agent_start", (event) => {
      if (add) {
        event.systemPromptOptions.appendSystemPrompt = "ADDED-INSTRUCTIONS";
        event.systemPromptOptions.sections.phase = "visible";
      }
      expectedPrompt = event.systemPrompt;
    });
  });
  for (const active of [false, true, false, true]) {
    add = active;
    await runtime.prompt("s1", "next");
    assert.equal(getCurrentSystemPrompt(tab.agentSession.messages), expectedPrompt);
    assert.equal(requests.at(-1)!.prompt.includes("ADDED-INSTRUCTIONS"), active);
    assert.equal(requests.at(-1)!.prompt.includes("<phase>"), active);
    assert.match(
      requests.at(-1)!.prompt,
      /Current date: [^\n]+\nCurrent working directory: [^\n]+\n$/,
    );
  }
  const head = getCurrentSystemMessage(tab.agentSession.messages);
  assert.equal(head?.sections?.addendum, "ADDED-INSTRUCTIONS");
});

test("unchanged instructions do not append a system prompt update", async (t) => {
  const { runtime, tab } = await fixture(t, () => {});
  await runtime.prompt("s1", "first");
  const count = tab.session.getEntries().length;
  await runtime.prompt("s1", "second");
  assert.deepEqual(
    tab.session
      .getEntries()
      .slice(count)
      .filter((entry) => entry.type === "message" && entry.message.role === "system"),
    [],
  );
});

test("resuming a single-section session replaces its prompt without rewriting history", async (t) => {
  const { runtime, tab, dir } = await fixture(t, () => {});
  const legacy = SessionManager.create(dir, path.join(dir, "legacy"));
  legacy.appendModelChange("prompt-transcript-test", MIXCODE_FAUX_MODEL.id);
  legacy.appendMessage({
    role: "system",
    content: "",
    sections: { preamble: "OLD-FULL-PROMPT" },
    timestamp: 1,
  });
  legacy.appendMessage({ role: "user", content: "old request", timestamp: 2 });
  legacy.appendMessage({
    ...fauxAssistantMessage("old response"),
    provider: "prompt-transcript-test",
    api: "prompt-transcript-test",
    model: MIXCODE_FAUX_MODEL.id,
  });
  const file = legacy.getSessionFile();
  assert.ok(file);
  const original = structuredClone(legacy.getEntries());
  await runtime.extensionSwitchSession(tab.tab.sessionId, file);
  const current = runtime.listTabs()[0]!;
  assert.deepEqual(current.session.getEntries().slice(0, original.length), original);
  assert.equal(getCurrentSystemPrompt(current.agentSession.messages), "OLD-FULL-PROMPT");
  await runtime.prompt(current.tab.sessionId, "new request");
  const updates = promptUpdates(current.session, original.length);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.sections?.preamble, "HOST-IDENTITY");
  assert.match(updates[0]!.sections?.tools ?? "", /Available tools:/);
  const effectivePrompt = getCurrentSystemPrompt(current.agentSession.messages);
  assert.doesNotMatch(effectivePrompt, /OLD-FULL-PROMPT/);
  assert.equal(effectivePrompt, current.agentSession.systemPrompt);
  assert.equal(
    getCurrentSystemPrompt(SessionManager.open(file).buildSessionContext().messages),
    effectivePrompt,
  );
  assert.deepEqual(current.session.getEntries().slice(0, original.length), original);
});

test("compaction checkpoints retain sections and the next request records only changed instructions", async (t) => {
  let phase = "before compact";
  const { runtime, tab, requests } = await fixture(t, (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.phase = phase;
    });
    pi.on("session_before_compact", (event) => ({
      compaction: {
        summary: "Keep the task context.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
  });
  await runtime.prompt("s1", "first");
  await runtime.prompt("s1", "second");
  tab.agentSession.settingsManager.applyOverrides({
    compaction: { reserveTokens: 1, keepRecentTokens: 1 },
  });
  await tab.agentSession.compact();
  const checkpoint = tab.session.getEntries().findLast((entry) => entry.type === "compaction");
  assert.ok(checkpoint?.type === "compaction" && checkpoint.systemMessage);
  assert.equal(checkpoint.systemMessage.sections?.extensions, "<phase>\nbefore compact\n</phase>");
  const offset = tab.session.getEntries().length;
  phase = "after compact";
  await runtime.prompt("s1", "continue");
  assert.deepEqual(
    promptUpdates(tab.session, offset).map((message) => message.sections),
    [{ extensions: "<phase>\nafter compact\n</phase>" }],
  );
  assert.equal(
    getCurrentSystemPrompt(tab.session.buildSessionContext().messages),
    requests.at(-1)!.prompt,
  );
});

test("mid-run tool changes update only the tool prompt group and declarations", async (t) => {
  const core = createFauxCore({
    provider: "prompt-transcript-test",
    api: "prompt-transcript-test",
  });
  core.setResponses([
    fauxAssistantMessage(fauxToolCall("select_read", {}, { id: "select" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Selected read."),
  ]);
  const { runtime, tab, requests } = await fixture(
    t,
    (pi) => {
      pi.registerTool({
        name: "select_read",
        label: "Select read",
        description: "Select only the read tool",
        parameters: Type.Object({}),
        promptGuidelines: ["SELECT-READ-GUIDELINE"],
        execute: async () => {
          pi.setActiveTools(["read"]);
          return { content: [{ type: "text", text: "selected" }], details: {} };
        },
      });
    },
    core.stream,
  );
  await runtime.prompt("s1", "select read");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.tools, ["read"]);
  assert.match(requests[0]!.prompt, /SELECT-READ-GUIDELINE/);
  assert.doesNotMatch(requests[1]!.prompt, /SELECT-READ-GUIDELINE/);
  const updates = promptUpdates(tab.session);
  assert.deepEqual(Object.keys(updates[1]!.sections ?? {}), ["tools"]);
  assert.ok(updates[1]!.toolsRemoved?.some((tool) => tool.name === "select_read"));
  const effective = getEffectiveSystemPrompt(tab.agentSession);
  assert.equal(effective?.text, requests[1]!.prompt);
  assert.equal(effective?.sections.map((section) => section.text).join(""), requests[1]!.prompt);
});

test("extension sections survive in the replayed prompt after a run settles", async (t) => {
  const { runtime, tab } = await fixture(t, (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections["example-extension"] = "EXTENSION-TEXT";
    });
  });
  await runtime.prompt("s1", "first");

  const effective = getEffectiveSystemPrompt(tab.agentSession);
  assert.ok(effective);
  assert.match(effective.text, /<example-extension>\nEXTENSION-TEXT\n<\/example-extension>/);
  assert.doesNotMatch(tab.agentSession.systemPrompt, /EXTENSION-TEXT/);
  assert.deepEqual(
    effective.sections.filter((section) => section.name === "extensions"),
    [{ name: "extensions", text: "\n\n<example-extension>\nEXTENSION-TEXT\n</example-extension>" }],
  );
  assert.equal(effective.sections.map((section) => section.text).join(""), effective.text);
});

test("replayed content becomes its own row so rows concatenate to the prompt", () => {
  const agentSession = {
    messages: [
      {
        role: "system",
        content: "LEGACY-PROMPT",
        sections: { preamble: "HOST-IDENTITY" },
        timestamp: 0,
      },
    ],
  } as unknown as AgentSession;

  const effective = getEffectiveSystemPrompt(agentSession);
  assert.ok(effective);
  assert.equal(effective.text, "LEGACY-PROMPT\n\nHOST-IDENTITY");
  assert.deepEqual(
    effective.sections.map((section) => section.name),
    ["content", "preamble"],
  );
  assert.equal(effective.sections.map((section) => section.text).join(""), effective.text);
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
