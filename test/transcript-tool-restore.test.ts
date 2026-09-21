import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  getCurrentTools,
  InMemoryCredentialStore,
  Type,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { createTab } from "../src/core/defaults.js";

const defaults = ["bash", "edit", "read", "write"];

async function fixture(
  t: TestContext,
  options: { extensions?: ExtensionFactory[]; defaultTools?: string[] } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-transcript-tools-"));
  const agentDir = path.join(root, "agent");
  await Bun.write(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      ...(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
    }),
  );
  const requests: string[][] = [];
  const runtimes: MixCodeRuntime[] = [];
  const config = {
    workdir: root,
    systemPrompt: "Tool restoration test.",
    thinkingLevel: "off" as const,
    model: { ...MIXCODE_FAUX_MODEL, provider: "tool-restore-test", api: "tool-restore-test" },
  };
  async function createRuntime() {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const core = createFauxCore({ api: config.model.api, provider: config.model.provider });
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(root, "sessions"),
      agentDir,
      modelRuntime,
      extensionFactories: options.extensions ?? [],
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
      streamFn: (model, context, streamOptions) => {
        requests.push(
          getCurrentTools(context.messages)
            .map((tool) => tool.name)
            .sort(),
        );
        core.setResponses([fauxAssistantMessage("Recorded active tools.")]);
        return core.stream(model, context, streamOptions);
      },
    });
    runtimes.push(runtime);
    return runtime;
  }
  t.after(async () => {
    for (const runtime of runtimes) await runtime.closeAllTabs();
    await fs.rm(root, { recursive: true, force: true });
  });
  const runtime = await createRuntime();
  const tab = await runtime.createTab(createTab(1, "tools", root), config);

  async function assertNextRequest(
    currentRuntime: MixCodeRuntime,
    current: RuntimeTab,
    expected: string[],
  ) {
    const names = [...expected].sort();
    assert.deepEqual(current.agentSession.getActiveToolNames().sort(), names);
    const requestOffset = requests.length;
    await currentRuntime.prompt(current.tab.sessionId, "Report your current tools.");
    assert.deepEqual(requests.slice(requestOffset), [names]);
    assert.deepEqual(
      getCurrentTools(current.agentSession.messages)
        .map((tool) => tool.name)
        .sort(),
      names,
    );
  }

  return { root, runtime, tab, config, createRuntime, assertNextRequest };
}

for (const transition of ["restart", "switch", "fork", "reload"] as const) {
  for (const selected of [["read"], []]) {
    test(`${transition} restores recorded tools ${JSON.stringify(selected)} into the next request`, async (t) => {
      const f = await fixture(t);
      f.tab.agentSession.setActiveToolsByName(selected);
      await f.runtime.prompt("tools", "Save this selection.");
      const file = f.tab.agentSession.sessionFile;
      assert.ok(file);
      let runtime = f.runtime;
      if (transition === "restart") {
        await runtime.closeAllTabs();
        runtime = await f.createRuntime();
        await runtime.createTab(createTab(1, "tools", f.root), f.config);
      } else if (transition === "switch") {
        await runtime.extensionSwitchSession("tools", file);
      } else if (transition === "fork") {
        const leaf = f.tab.session.getLeafId();
        assert.ok(leaf);
        await runtime.extensionFork("tools", leaf, { position: "at" });
      } else {
        await runtime.extensionReload("tools");
      }
      await f.assertNextRequest(runtime, runtime.listTabs()[0]!, selected);
    });
  }
}

test("a legacy conversation without a system checkpoint uses configured defaults", async (t) => {
  const f = await fixture(t, { defaultTools: ["read", "ls"] });
  const legacy = SessionManager.create(f.root, path.join(f.root, "legacy"));
  legacy.appendMessage({ role: "user", content: "Old conversation", timestamp: 1 });
  const file = legacy.getSessionFile();
  assert.ok(file);
  // SessionManager flushes the file only after an assistant message.
  legacy.appendMessage({
    ...fauxAssistantMessage("Old answer"),
    api: f.config.model.api,
    provider: f.config.model.provider,
    model: f.config.model.id,
    timestamp: 2,
  });
  await f.runtime.extensionSwitchSession("tools", file);
  await f.assertNextRequest(f.runtime, f.runtime.listTabs()[0]!, ["ls", "read"]);
});

test("recorded explicit selections survive defaults that only seed new sessions", async (t) => {
  const f = await fixture(t, { defaultTools: ["read"] });
  f.tab.agentSession.setActiveToolsByName(["read", "write"]);
  await f.runtime.prompt("tools", "Save explicitly enabled write.");
  await f.runtime.extensionReload("tools");
  await f.assertNextRequest(f.runtime, f.runtime.listTabs()[0]!, ["read", "write"]);
});

test("current session_start policy can narrow the restored selection", async (t) => {
  let restrict = false;
  const f = await fixture(t, {
    extensions: [
      (pi) => {
        pi.on("session_start", () => {
          if (restrict) pi.setActiveTools(["read"]);
        });
      },
    ],
  });
  await f.runtime.prompt("tools", "Save defaults.");
  restrict = true;
  await f.runtime.extensionReload("tools");
  await f.assertNextRequest(f.runtime, f.runtime.listTabs()[0]!, ["read"]);
});

test("restoration uses registered implementations and drops unavailable historical tools", async (t) => {
  let available = true;
  const f = await fixture(t, {
    extensions: [
      (pi) => {
        if (!available) return;
        pi.registerTool({
          name: "temporary_tool",
          label: "Temporary",
          description: "Temporary test tool",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        });
      },
    ],
  });
  f.tab.agentSession.setActiveToolsByName(["read", "temporary_tool"]);
  await f.runtime.prompt("tools", "Save temporary tool.");
  available = false;
  await f.runtime.extensionReload("tools");
  await f.assertNextRequest(f.runtime, f.runtime.listTabs()[0]!, ["read"]);
});

for (const [initial, selected] of [
  [defaults, ["read"]],
  [["read"], []],
  [["read"], ["read", "grep"]],
] satisfies Array<[string[], string[]]>) {
  test(`peer sync restores tools ${JSON.stringify(initial)} -> ${JSON.stringify(selected)}`, async (t) => {
    const f = await fixture(t);
    f.tab.agentSession.setActiveToolsByName(initial);
    await f.runtime.prompt("tools", "Create shared session.");
    const peer = await f.createRuntime();
    const peerTab = await peer.createTab(createTab(1, "tools", f.root), f.config);
    // Align the peer before testing a later change, independently of resume behavior.
    peerTab.agentSession.setActiveToolsByName(initial);
    f.tab.agentSession.setActiveToolsByName(selected);
    await f.runtime.prompt("tools", "Persist changed tools.");
    assert.equal(peer.syncSessionFromDisk("tools"), true);
    await f.assertNextRequest(peer, peerTab, selected);
  });
}

test("the first peer checkpoint can declare an empty tool set", async (t) => {
  const f = await fixture(t);
  const peer = await f.createRuntime();
  const peerTab = await peer.createTab(createTab(1, "tools", f.root), f.config);
  assert.deepEqual(peerTab.agentSession.getActiveToolNames().sort(), defaults);
  // Opening an unstarted session adds local model metadata. Navigate back to the
  // shared on-disk leaf so the first response extends both instances' branch.
  const sharedLeaf = f.tab.session.getLeafId();
  assert.ok(sharedLeaf);
  await peer.extensionNavigateTree("tools", sharedLeaf, { summarize: false });
  f.tab.agentSession.setActiveToolsByName([]);
  await f.runtime.prompt("tools", "Persist the first checkpoint without tools.");
  assert.equal(peer.syncSessionFromDisk("tools"), true);
  await f.assertNextRequest(peer, peerTab, []);
});

test("fork restores the selected historical loadout instead of the latest one", async (t) => {
  const f = await fixture(t);
  f.tab.agentSession.setActiveToolsByName(["read"]);
  await f.runtime.prompt("tools", "Read-only branch point.");
  const anchor = f.tab.session.getLeafId();
  assert.ok(anchor);
  f.tab.agentSession.setActiveToolsByName(["write"]);
  await f.runtime.prompt("tools", "Continue with write.");
  await f.runtime.extensionFork("tools", anchor, { position: "at" });
  await f.assertNextRequest(f.runtime, f.runtime.listTabs()[0]!, ["read"]);
});

test("reload restores an empty loadout from a compaction checkpoint", async (t) => {
  const f = await fixture(t, {
    extensions: [
      (pi) => {
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "Preserve the current task.",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
      },
    ],
  });
  f.tab.agentSession.setActiveToolsByName([]);
  await f.runtime.prompt("tools", "First turn without tools.");
  await f.runtime.prompt("tools", "Second turn without tools.");
  f.tab.agentSession.settingsManager.applyOverrides({
    compaction: { reserveTokens: 1, keepRecentTokens: 1 },
  });
  await f.tab.agentSession.compact();
  const checkpoint = f.tab.session.getEntries().findLast((entry) => entry.type === "compaction");
  assert.ok(checkpoint?.type === "compaction" && checkpoint.systemMessage);
  await f.runtime.extensionReload("tools");
  await f.assertNextRequest(f.runtime, f.runtime.listTabs()[0]!, []);
});

test("peer metadata changes preserve local tool choices not yet sent to the model", async (t) => {
  const f = await fixture(t);
  await f.runtime.prompt("tools", "Create shared session.");
  const peer = await f.createRuntime();
  const peerTab = await peer.createTab(createTab(1, "tools", f.root), f.config);
  peerTab.agentSession.setActiveToolsByName(["read"]);
  f.runtime.renameSession("tools", "Renamed by peer");
  assert.equal(peer.syncSessionFromDisk("tools"), true);
  assert.equal(peerTab.tab.title, "Renamed by peer");
  await f.assertNextRequest(peer, peerTab, ["read"]);
});
