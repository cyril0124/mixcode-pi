import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL, mixcodeFauxStream } from "../src/agent/faux-stream.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { addPromptHistory } from "../src/ui/app-editor.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { hydrateTabPromptHistory } from "../src/ui/app-runtime.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import { testTui } from "./helpers/tui.js";

function lastUserText(context: TranscriptContext): string {
  const message = context.messages.findLast((message) => message.role === "user");
  assert.ok(message && message.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

async function fixture(t: TestContext, blockFirst = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-tab-reference-input-"));
  const state = createInitialState(dir);
  const tab = createTab(1, "self", dir, { title: "Self" });
  const peer = createTab(2, "peer", dir, { title: "Review" });
  state.tabs.push(tab, peer);
  state.activeTabId = tab.sessionId;
  const requests: string[] = [];
  const providerMessages: string[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir: path.join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    streamFn: (model, context, options) => {
      requests.push(lastUserText(context));
      providerMessages.push(JSON.stringify(context.messages));
      if (blockFirst && requests.length === 1) {
        const stream = createAssistantMessageEventStream();
        started.resolve();
        void release.promise.then(() => {
          stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("released") });
          stream.end();
        });
        return stream;
      }
      return mixcodeFauxStream(model, context, options);
    },
  });
  const runtimeTab = await runtime.createTab(tab, {
    model: { ...MIXCODE_FAUX_MODEL, provider: "tab-reference-test", api: "tab-reference-test" },
    workdir: dir,
    systemPrompt: "Test",
    thinkingLevel: "off",
  });
  t.after(async () => {
    release.resolve();
    await runtimeTab.agentSession.waitForIdle();
    await runtime.closeAllTabs();
    await fs.rm(dir, { recursive: true, force: true });
  });
  let editorText = "";
  const editor = {
    getText: () => editorText,
    setText: (text: string) => {
      editorText = text;
    },
    addToHistory: (text: string) => addPromptHistory(tab, text),
  };
  const tui = testTui();
  const submit = (text: string) =>
    handleSubmittedInput(
      state,
      runtime,
      text,
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      editor,
      false,
      "editor",
    );
  return {
    dir,
    state,
    tab,
    peer,
    runtime,
    runtimeTab,
    requests,
    providerMessages,
    editor,
    tui,
    submit,
    started: started.promise,
    release: release.resolve,
  };
}

test("editor submissions reach the provider with context while programmatic input stays literal", async (t) => {
  const f = await fixture(t);
  await handleSubmittedInput(f.state, f.runtime, "Inspect @Review", f.tui);
  assert.equal(f.requests[0], "Inspect @Review");
  f.editor.addToHistory("Inspect @Review");
  await f.submit("Inspect @Review");
  assert.deepEqual(
    f.runtimeTab.agentSession.messages.filter((message) => message.role === "user").at(-1)?.content,
    [{ type: "text", text: "Inspect @Review" }],
  );
  const hidden = f.runtimeTab.agentSession.messages.find(
    (message) => message.role === "custom" && message.customType === "tab-references",
  );
  assert.ok(hidden && hidden.role === "custom");
  assert.equal(hidden.display, false);
  assert.match(JSON.stringify(hidden.content), /peer/);
  assert.equal(
    f.runtimeTab.chat.some((line) => line.text.includes("mpi-tab-references")),
    false,
  );
  assert.match(f.providerMessages[1]!, /mpi-tab-references/);
  const saved = SessionManager.open(f.runtimeTab.agentSession.sessionFile!).buildSessionContext()
    .messages;
  assert.deepEqual(saved.filter((message) => message.role === "user").at(-1)?.content, [
    { type: "text", text: "Inspect @Review" },
  ]);
  assert.ok(
    saved.some(
      (message) =>
        message.role === "custom" &&
        message.customType === "tab-references" &&
        message.display === false,
    ),
  );
  f.tab.promptHistory = [];
  hydrateTabPromptHistory(f.state, f.runtime);
  assert.deepEqual(f.tab.promptHistory, ["Inspect @Review"]);
});

test("an ambiguous editor submission restores the draft and makes no provider request", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "Review"), "file");
  await assert.rejects(f.submit("Inspect @Review"), /Error: File or directory conflicts/);
  assert.equal(f.editor.getText(), "Inspect @Review");
  assert.deepEqual(f.requests, []);
});

test("Home resolves references relative to the selected recipient without changing focus", async (t) => {
  const f = await fixture(t);
  f.state.activeTabId = "home";
  f.state.homeSelectedTabIndex = 0;
  f.editor.setText("Inspect @Review");
  const completed = Promise.withResolvers<void>();
  const unsubscribe = f.runtime.onChange(() => {
    if (
      f.runtimeTab.chat.some(
        (line) => line.role === "assistant" && line.text === "Echo: Inspect @Review",
      )
    )
      completed.resolve();
  });
  t.after(unsubscribe);
  handleMixCodeKeyInput(
    f.state,
    "\r",
    f.tui,
    undefined,
    f.runtime,
    undefined,
    () => false,
    f.editor,
  );
  await completed.promise;
  assert.equal(f.requests[0], "Inspect @Review");
  assert.match(f.providerMessages[0]!, /mpi-tab-references/);
  assert.equal(f.state.activeTabId, "home");
  assert.equal(f.editor.getText(), "");
  assert.deepEqual(f.tab.promptHistory, ["Inspect @Review"]);
});

test("Alt+Enter defers context and Ctrl+U restores the original user text", async (t) => {
  const f = await fixture(t);
  f.tab.followUpsPaused = true;
  f.editor.setText("Inspect @Review");
  const queued = Promise.withResolvers<void>();
  const unsubscribe = f.runtime.onChange(() => {
    if (f.tab.followUpQueue.length === 1) queued.resolve();
  });
  t.after(unsubscribe);
  handleMixCodeKeyInput(
    f.state,
    "\x1b\r",
    f.tui,
    undefined,
    f.runtime,
    undefined,
    () => false,
    f.editor,
  );
  await queued.promise;
  f.peer.title = "Renamed";
  assert.equal(f.tab.followUpQueue[0]!.text, "Inspect @Review");
  assert.equal(
    f.runtimeTab.agentSession.messages.some(
      (message) => message.role === "custom" && message.customType === "tab-references",
    ),
    false,
  );
  assert.equal(f.editor.getText(), "");
  handleMixCodeKeyInput(
    f.state,
    "\x15",
    f.tui,
    undefined,
    f.runtime,
    undefined,
    () => false,
    f.editor,
  );
  assert.equal(f.editor.getText(), "Inspect @Review");
  assert.deepEqual(f.tab.followUpQueue, []);
  assert.deepEqual(f.tab.promptHistory, ["Inspect @Review"]);
});

test("follow-up context stays hidden and retains the target captured before a rename", async (t) => {
  const f = await fixture(t);
  f.tab.followUpsPaused = true;
  f.editor.setText("Inspect @Review");
  const queued = Promise.withResolvers<void>();
  const unsubscribe = f.runtime.onChange(() => {
    if (f.tab.followUpQueue.length === 1) queued.resolve();
  });
  t.after(unsubscribe);
  handleMixCodeKeyInput(
    f.state,
    "\x1b\r",
    f.tui,
    undefined,
    f.runtime,
    undefined,
    () => false,
    f.editor,
  );
  await queued.promise;
  f.peer.title = "Renamed";
  await f.runtime.resumeFollowUps(f.tab.sessionId);
  assert.deepEqual(f.requests, ["Inspect @Review"]);
  const hidden = f.runtimeTab.agentSession.messages.find(
    (message) => message.role === "custom" && message.customType === "tab-references",
  );
  assert.ok(hidden && hidden.role === "custom");
  assert.equal(hidden.display, false);
  assert.match(String(hidden.content), /"title": "Review"/);
  assert.match(String(hidden.content), /"sessionId": "peer"/);
  assert.equal(
    f.runtimeTab.chat.some((line) => line.text.includes("mpi-tab-references")),
    false,
  );
});

test("compaction-deferred context is delivered with plain text and discarded on withdrawal", async (t) => {
  const f = await fixture(t);
  f.runtimeTab.compactionInFlight = true;
  await f.submit("Inspect @Review");
  assert.deepEqual(f.tab.pendingMessages, ["Inspect @Review"]);
  assert.equal(f.runtime.popPendingMessage(f.tab.sessionId, "steering"), "Inspect @Review");
  f.runtimeTab.compactionInFlight = false;
  await f.submit("plain after withdrawal");
  assert.doesNotMatch(f.providerMessages[0]!, /mpi-tab-references/);
  f.runtimeTab.compactionInFlight = true;
  await f.submit("Inspect @Review");
  f.runtimeTab.compactionInFlight = false;
  await f.runtime.flushPendingMessage(f.tab.sessionId);
  assert.equal(f.requests.at(-1), "Inspect @Review");
  assert.match(f.providerMessages.at(-1)!, /mpi-tab-references/);
  assert.equal(
    f.runtimeTab.chat.some((line) => line.text.includes("mpi-tab-references")),
    false,
  );
});

test("withdrawing a deferred prompt preserves earlier context when a draft is prepended", async (t) => {
  const f = await fixture(t);
  f.runtimeTab.compactionInFlight = true;
  await f.submit("Inspect @Review");
  await f.submit("later plain prompt");
  f.editor.setText("unsent draft");
  handleMixCodeKeyInput(
    f.state,
    "\x15",
    f.tui,
    undefined,
    f.runtime,
    undefined,
    () => false,
    f.editor,
  );
  assert.equal(f.editor.getText(), "later plain prompt");
  assert.deepEqual(f.tab.pendingMessages, ["unsent draft", "Inspect @Review"]);
  f.runtimeTab.compactionInFlight = false;
  await f.runtime.flushPendingMessage(f.tab.sessionId, 1);
  assert.equal(f.requests.at(-1), "Inspect @Review");
  assert.match(f.providerMessages.at(-1)!, /mpi-tab-references/);
});

test("a reference submitted during streaming travels through steering to the provider", async (t) => {
  const f = await fixture(t, true);
  const initial = f.runtime.prompt(f.tab.sessionId, "Start");
  await f.started;
  await f.submit("Inspect @Review");
  assert.equal(f.runtimeTab.agentSession.getSteeringMessages()[0], "Inspect @Review");
  f.release();
  await initial;
  await f.runtimeTab.agentSession.waitForIdle();
  assert.equal(f.requests.at(-1), "Inspect @Review");
  assert.match(f.providerMessages.at(-1)!, /mpi-tab-references/);
  assert.equal(
    f.runtimeTab.chat.some((line) => line.text.includes("mpi-tab-references")),
    false,
  );
});
