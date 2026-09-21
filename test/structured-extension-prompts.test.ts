import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import bashExtension from "../pi-packages/mpi-bash/index.js";
import historyExtension from "../pi-packages/mpi-prompt-history/index.js";
import modelAttachExtension from "../pi-packages/mpi-model-attach/index.js";
import { MIXCODE_FAUX_MODEL, mixcodeFauxStream } from "../src/agent/faux-stream.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { createTab } from "../src/core/defaults.js";

async function fixture(t: TestContext, extensions: ExtensionFactory[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-structured-prompts-"));
  const agentDir = path.join(dir, "agent");
  const previousEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    MIXCODE: process.env.MIXCODE,
    MIXCODE_PID: process.env.MIXCODE_PID,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Enable history injection after startup, avoiding its unrelated background backfill.
  process.env.MIXCODE = "0";
  await Bun.write(
    path.join(agentDir, "skills", "original", "SKILL.md"),
    "---\nname: original\ndescription: Original skill\n---\nOriginal instructions.\n",
  );
  const attachedPath = path.join(dir, "attached", "SKILL.md");
  await Bun.write(
    attachedPath,
    "---\nname: attached\ndescription: Attached skill with literal $& and $$\n---\nAttached instructions.\n",
  );
  await Bun.write(
    path.join(agentDir, "mpi-model-attach.json"),
    JSON.stringify({
      skills: {
        rules: [
          {
            match: { model: `structured-probe/${MIXCODE_FAUX_MODEL.id}` },
            remove: ["original"],
            add: [attachedPath],
          },
        ],
      },
    }),
  );
  const requests: TranscriptContext[] = [];
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    extensionFactories: extensions,
    resourceLoaderOptions: {
      skillsOverride: ({ skills, diagnostics }) => ({
        skills: skills.filter((skill) => skill.filePath.startsWith(`${agentDir}${path.sep}`)),
        diagnostics,
      }),
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    },
    streamFn: (model, context, options) => {
      requests.push(structuredClone(context));
      return mixcodeFauxStream(model, context, options);
    },
  });
  t.after(async () => {
    await runtime.closeAllTabs();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const tab = await runtime.createTab(createTab(1, "structured", dir), {
    model: { ...MIXCODE_FAUX_MODEL, provider: "structured-probe", api: "structured-probe" },
    systemPrompt: "HOST-IDENTITY",
    thinkingLevel: "off",
    workdir: dir,
  });
  process.env.MIXCODE = "1";
  process.env.MIXCODE_PID = String(process.pid);
  // Extension-source prompts still exercise before_agent_start, without recording recall history.
  const prompt = (text: string) => tab.agentSession.prompt(text, { source: "extension" });
  return { tab, requests, prompt, agentDir };
}

const extensionOrders: Array<[string, ExtensionFactory[]]> = [
  ["bash, history, skills", [bashExtension, historyExtension, modelAttachExtension]],
  ["bash, skills, history", [bashExtension, modelAttachExtension, historyExtension]],
  ["history, bash, skills", [historyExtension, bashExtension, modelAttachExtension]],
  ["history, skills, bash", [historyExtension, modelAttachExtension, bashExtension]],
  ["skills, bash, history", [modelAttachExtension, bashExtension, historyExtension]],
  ["skills, history, bash", [modelAttachExtension, historyExtension, bashExtension]],
];

for (const [order, extensions] of extensionOrders) {
  test(`structured extension instructions survive hook composition: ${order}`, async (t) => {
    const laterSection: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections["later-policy"] = "LATER-STRUCTURED-INSTRUCTION";
      });
    };
    const { tab, requests, prompt, agentDir } = await fixture(t, [...extensions, laterSection]);
    await prompt("first");
    const sent = getCurrentSystemPrompt(requests[0]!.messages);
    assert.match(sent, /LATER-STRUCTURED-INSTRUCTION/);
    assert.match(sent, /default timeout of 300 seconds/);
    assert.match(sent, /moved to the background instead of being killed/);
    assert.match(sent, /exit code is delivered to you automatically/);
    assert.ok(sent.includes(path.join(agentDir, "mpi-prompt-history", "history.jsonl")));
    assert.match(sent, /Use these files only when the user explicitly asks/);
    assert.match(sent, /<name>attached<\/name>/);
    assert.doesNotMatch(sent, /<name>original<\/name>/);
    assert.ok(sent.includes("literal $&amp; and $$"));
    assert.equal(getCurrentSystemPrompt(tab.agentSession.messages), sent);
    const file = tab.agentSession.sessionFile;
    assert.ok(file);
    assert.equal(
      getCurrentSystemPrompt(SessionManager.open(file).buildSessionContext().messages),
      sent,
    );
  });
}

test("unchanged package instructions stay single and later changes preserve the transcript prefix", async (t) => {
  let policy = "POLICY-ONE";
  const laterSection: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections["later-policy"] = policy;
    });
  };
  const { tab, requests, prompt } = await fixture(t, [
    bashExtension,
    historyExtension,
    modelAttachExtension,
    laterSection,
  ]);
  await prompt("first");
  const firstLeaf = tab.session.getLeafId();
  assert.ok(firstLeaf);
  const firstEntries = structuredClone(tab.session.getEntries());
  await prompt("unchanged");
  assert.deepEqual(
    tab.session
      .getEntries()
      .slice(firstEntries.length)
      .filter((entry) => entry.type === "message" && entry.message.role === "system"),
    [],
  );
  const offset = tab.session.getEntries().length;
  policy = "POLICY-TWO";
  await prompt("changed");
  const updates = tab.session
    .getEntries()
    .slice(offset)
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
    );
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0]!.sections ?? {}), ["extensions"]);
  const sent = getCurrentSystemPrompt(requests.at(-1)!.messages);
  assert.match(sent, /POLICY-TWO/);
  assert.equal(sent.split("Bash execution policy:").length - 1, 1);
  assert.equal(sent.split("Local conversation history:").length - 1, 1);
  assert.deepEqual(tab.session.getEntries().slice(0, firstEntries.length), firstEntries);
  const reopened = SessionManager.open(tab.agentSession.sessionFile!);
  reopened.branch(firstLeaf);
  assert.equal(
    getCurrentSystemPrompt(reopened.buildSessionContext().messages),
    getCurrentSystemPrompt(requests[0]!.messages),
  );
});

test("history injection retains its gate without suppressing other structured instructions", async (t) => {
  const { requests, prompt } = await fixture(t, [bashExtension, historyExtension]);
  process.env.MIXCODE = "0";
  await prompt("disabled");
  assert.doesNotMatch(getCurrentSystemPrompt(requests[0]!.messages), /Local conversation history:/);
  process.env.MIXCODE = "1";
  await prompt("enabled");
  assert.match(getCurrentSystemPrompt(requests[1]!.messages), /Local conversation history:/);
  process.env.MIXCODE_PID = "0";
  await prompt("child process");
  const sent = getCurrentSystemPrompt(requests[2]!.messages);
  assert.doesNotMatch(sent, /Local conversation history:/);
  assert.match(sent, /Bash execution policy:/);
});

test("model changes update persisted skills without replacing other instructions", async (t) => {
  const { tab, requests, prompt } = await fixture(t, [
    bashExtension,
    historyExtension,
    modelAttachExtension,
  ]);
  await prompt("matching model");
  const offset = tab.session.getEntries().length;
  const model = tab.agentSession.model;
  assert.ok(model);
  await tab.agentSession.setModel({ ...model, id: "no-skill-rule" });
  await prompt("unmatched model");
  const sent = getCurrentSystemPrompt(requests.at(-1)!.messages);
  assert.match(sent, /<name>original<\/name>/);
  assert.doesNotMatch(sent, /<name>attached<\/name>/);
  assert.match(sent, /Bash execution policy:/);
  assert.match(sent, /Local conversation history:/);
  const updates = tab.session
    .getEntries()
    .slice(offset)
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
    );
  assert.deepEqual(
    updates.map((update) => Object.keys(update.sections ?? {})),
    [["skills"]],
  );
  assert.equal(getCurrentSystemPrompt(tab.agentSession.messages), sent);
});

test("attached skills respect the active file-reading tools", async (t) => {
  const { tab, requests, prompt } = await fixture(t, [bashExtension, modelAttachExtension]);
  tab.agentSession.setActiveToolsByName([]);
  await prompt("no file-reading tools");
  const sent = getCurrentSystemPrompt(requests[0]!.messages);
  assert.doesNotMatch(sent, /<available_skills>/);
  assert.match(sent, /Bash execution policy:/);
  assert.equal(getCurrentSystemPrompt(tab.agentSession.messages), sent);
});

test("an explicit third-party forced prompt still wins for only its run", async (t) => {
  const forcedPrompt: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => {
      if (event.prompt === "force") return { systemPrompt: "EXACT-THIRD-PARTY-PROMPT" };
    });
  };
  const { tab, requests, prompt } = await fixture(t, [
    forcedPrompt,
    bashExtension,
    historyExtension,
    modelAttachExtension,
  ]);
  await prompt("force");
  assert.equal(getCurrentSystemPrompt(requests[0]!.messages), "EXACT-THIRD-PARTY-PROMPT");
  const recorded = getCurrentSystemPrompt(tab.agentSession.messages);
  assert.match(recorded, /Bash execution policy:/);
  assert.match(recorded, /<name>attached<\/name>/);
  assert.doesNotMatch(recorded, /EXACT-THIRD-PARTY-PROMPT/);
  await prompt("normal");
  assert.equal(getCurrentSystemPrompt(requests[1]!.messages), recorded);
});
