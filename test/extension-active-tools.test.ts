import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MIXCODE_FAUX_MODEL } from "../src/agent/faux-stream.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { createTab } from "../src/core/defaults.js";

const model = { ...MIXCODE_FAUX_MODEL, provider: "active-tools-test", id: "active-tools-test" };
const lateToolName = "active_tools_probe";
const lateToolSnippet = "Report the active-tools probe result.";

type Transition = "startup" | "clear" | "new" | "fork" | "switch" | "reload" | "workdir";

async function createFixture(t: TestContext, selectedTools: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-active-tools-"));
  const requests: Array<{ tools: string[]; systemPrompt: string | undefined }> = [];
  const observations: Array<{ tools: string[]; promptTools: string[] }> = [];
  const core = createFauxCore({ api: model.api, provider: model.provider });
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", () => pi.setActiveTools(selectedTools));
    pi.registerCommand("audit-active", {
      handler: async (_args, ctx) => {
        observations.push({
          tools: pi.getActiveTools(),
          promptTools: ctx.getSystemPromptOptions().selectedTools ?? [],
        });
      },
    });
    pi.registerCommand("audit-new", {
      handler: async (_args, ctx) => {
        await ctx.newSession();
      },
    });
    pi.registerCommand("audit-fork", {
      handler: async (args, ctx) => {
        await ctx.fork(args);
      },
    });
    pi.registerCommand("audit-switch", {
      handler: async (args, ctx) => {
        await ctx.switchSession(args);
      },
    });
    pi.registerCommand("audit-reload", {
      handler: async (_args, ctx) => {
        await ctx.reload();
      },
    });
    pi.registerCommand("audit-enable-write", {
      handler: async () => pi.setActiveTools(["read", "write"]),
    });
    pi.registerCommand("audit-add-tool", {
      handler: async () => {
        pi.registerTool({
          name: lateToolName,
          label: "Active tools probe",
          description: "Report the active-tools probe result.",
          promptSnippet: lateToolSnippet,
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "probe result" }],
            details: undefined,
          }),
        });
        pi.setActiveTools([...new Set([...pi.getActiveTools(), lateToolName])]);
      },
    });
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const runtime = new MixCodeRuntime({
    modelRuntime,
    agentDir: path.join(root, "agent"),
    sessionsRoot: path.join(root, "sessions"),
    extensionFactories: [extension],
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
    // Capture tool definitions and system prompt sent to the model.
    streamFn: (requestModel, context, options) => {
      requests.push({
        tools: (context.tools ?? []).map((tool) => tool.name).sort(),
        systemPrompt: context.systemPrompt,
      });
      core.setResponses([fauxAssistantMessage("Recorded tool selection.")]);
      return core.stream(requestModel, context, options);
    },
  });
  t.after(async () => {
    try {
      await runtime.closeAllTabs();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const config = {
    systemPrompt: "Test active tool selection.",
    thinkingLevel: "off" as const,
    workdir: root,
    model,
  };
  await runtime.createTab(createTab(1, "active-tools", root), config);

  async function transition(kind: Transition): Promise<void> {
    const current = runtime.listTabs()[0]!;
    const sessionId = current.tab.sessionId;
    switch (kind) {
      case "startup":
        return;
      case "clear":
        await runtime.clearTab(sessionId, config);
        return;
      case "new":
        await runtime.prompt(sessionId, "/audit-new");
        return;
      case "fork": {
        await runtime.prompt(sessionId, "Create a fork anchor.");
        const anchor = current.session
          .getBranch()
          .find((entry) => entry.type === "message" && entry.message.role === "user");
        assert.ok(anchor);
        await runtime.prompt(sessionId, `/audit-fork ${anchor.id}`);
        return;
      }
      case "switch": {
        await runtime.prompt(sessionId, "Create a resume anchor.");
        const target = await runtime.forkSession(sessionId, "active-tools-target");
        const file = target.getSessionFile();
        assert.ok(file);
        await runtime.prompt(sessionId, `/audit-switch ${file}`);
        return;
      }
      case "reload":
        await runtime.prompt(sessionId, "/audit-reload");
        return;
      case "workdir": {
        const next = path.join(root, "next");
        await fs.mkdir(next);
        await runtime.updateTabWorkdir(sessionId, next, config.systemPrompt);
        return;
      }
    }
  }

  async function observeNextRequest(expectedTools: string[]): Promise<void> {
    const sessionId = runtime.listTabs()[0]!.tab.sessionId;
    await runtime.prompt(sessionId, "/audit-active");
    requests.length = 0;
    await runtime.prompt(sessionId, "Report the current selection.");
    const expected = [...expectedTools].sort();
    assert.deepEqual(
      requests.map((request) => request.tools),
      [expected],
      "the next model request must use the extension-selected tools",
    );
    const observed = observations.at(-1);
    assert.ok(observed);
    assert.deepEqual([...observed.tools].sort(), expected);
    assert.deepEqual([...observed.promptTools].sort(), expected);
  }

  return { runtime, requests, transition, observeNextRequest };
}

const transitions: Transition[] = [
  "startup",
  "clear",
  "new",
  "fork",
  "switch",
  "reload",
  "workdir",
];
for (const kind of transitions) {
  for (const selected of [["read"], []]) {
    test(`${kind} preserves session_start selection ${JSON.stringify(selected)} in the next model request`, async (t) => {
      const fixture = await createFixture(t, selected);
      await fixture.transition(kind);
      await fixture.observeNextRequest(selected);
    });
  }
}

test("an extension can explicitly re-enable write after starting read-only", async (t) => {
  const fixture = await createFixture(t, ["read"]);
  await fixture.runtime.prompt("active-tools", "/audit-enable-write");
  await fixture.observeNextRequest(["read", "write"]);
});

test("late extension tools update model definitions and prompt metadata without restoring defaults", async (t) => {
  const fixture = await createFixture(t, ["read"]);
  await fixture.runtime.prompt("active-tools", "/audit-add-tool");
  await fixture.observeNextRequest(["read", lateToolName]);
  assert.ok(fixture.requests.at(-1)?.systemPrompt?.includes(lateToolSnippet));
});
