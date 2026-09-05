import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Text, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createTab,
  renderAgentSurface,
} from "./helpers/mixcode.js";

function silentTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

test("runtime extension reload rejects active streaming or compaction state", async () => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "mixcode-runtime-extension-reload-busy-"),
  );
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    Object.defineProperty(runtimeTab.agentSession, "isStreaming", {
      configurable: true,
      get: () => true,
    });
    await assert.rejects(() => runtime.extensionReload("s1"), /streaming/);

    Object.defineProperty(runtimeTab.agentSession, "isStreaming", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(runtimeTab.agentSession, "isCompacting", {
      configurable: true,
      get: () => true,
    });
    await assert.rejects(() => runtime.extensionReload("s1"), /compaction/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime wires extension command session actions into MixCode sessions", async () => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "mixcode-runtime-extension-actions-"),
  );
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("new-action-session", {
      description: "Create a replacement session",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        const result = await ctx.newSession({
          parentSession: "parent-session.jsonl",
          setup: async (session) => {
            events.push(`setup:${session.getHeader()?.parentSession ?? "none"}`);
            session.appendMessage({ role: "user", content: "setup prompt", timestamp: Date.now() });
          },
          withSession: async (replacementCtx) => {
            events.push(`with-new:${replacementCtx.sessionManager.getSessionId()}`);
            await replacementCtx.sendMessage({
              customType: "replacement-note",
              content: "fresh context",
              display: true,
            });
          },
        });
        events.push(`new-result:${result.cancelled}`);
      },
    });
    pi.registerCommand("navigate-action-session", {
      description: "Navigate inside a session tree",
      handler: async (args, ctx) => {
        const result = await ctx.navigateTree(args.trim());
        events.push(`navigate:${result.cancelled}`);
      },
    });
    pi.registerCommand("fork-action-session", {
      description: "Fork from a user message",
      handler: async (args, ctx) => {
        const result = await ctx.fork(args.trim(), {
          withSession: async (replacementCtx) => {
            events.push(`with-fork:${replacementCtx.sessionManager.getSessionId()}`);
          },
        });
        events.push(`fork:${result.cancelled}`);
      },
    });
    pi.registerCommand("switch-action-session", {
      description: "Switch to a session file",
      handler: async (args, ctx) => {
        const result = await ctx.switchSession(args.trim(), {
          withSession: async (replacementCtx) => {
            events.push(`with-switch:${replacementCtx.sessionManager.getSessionId()}`);
          },
        });
        events.push(`switch:${result.cancelled}`);
      },
    });
    pi.on("session_start", (event) => {
      events.push(`start:${event.reason}`);
    });
    pi.on("session_before_switch", (event) => {
      events.push(`before-switch:${event.reason}`);
    });
    pi.on("session_before_fork", (event) => {
      events.push(`before-fork:${event.entryId}:${event.position}`);
    });
    pi.on("session_shutdown", (event, ctx) => {
      events.push(
        `shutdown:${event.reason}:${event.targetSessionFile ? "target" : "none"}:${ctx.sessionManager.getSessionId()}`,
      );
    });
    pi.registerMessageRenderer(
      "replacement-note",
      (message) => new Text(`replacement ${message.content}`, 0, 0),
    );
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    await runtime.prompt("s1", "/new-action-session");
    const afterNew = runtime.listTabs()[0]!;
    assert.equal(runtime.getTab("s1"), undefined);
    assert.equal(afterNew.session.getHeader()?.parentSession, "parent-session.jsonl");
    assert.equal(
      afterNew.chat.some((line) => line.role === "user" && line.text === "setup prompt"),
      true,
    );
    assert.match(
      renderAgentSurface(afterNew.tab, afterNew, 100).join("\n"),
      /replacement fresh context/,
    );

    const rootUserId = afterNew.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(rootUserId);
    await runtime.prompt(afterNew.tab.sessionId, "child prompt");
    runtime.setExtensionUiHost({
      tui: new TuiMainScreen(silentTerminal()),
      editor: {
        getText: () => "",
        setText: (text) => events.push(`editor:${text}`),
        pasteToEditor: () => undefined,
      },
    });
    await runtime.prompt(afterNew.tab.sessionId, `/navigate-action-session ${rootUserId}`);
    assert.equal(
      afterNew.chat.some((line) => line.role === "user" && line.text === "child prompt"),
      false,
    );
    assert.ok(events.includes("editor:setup prompt"));

    await runtime.prompt(afterNew.tab.sessionId, "fork base prompt");
    const activeUserId = afterNew.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(activeUserId);
    const beforeForkSessionId = afterNew.tab.sessionId;
    await runtime.prompt(afterNew.tab.sessionId, `/fork-action-session ${activeUserId}`);
    const afterFork = runtime.listTabs()[0]!;
    assert.notEqual(afterFork.tab.sessionId, beforeForkSessionId);

    const switchTarget = await runtime.forkSession(afterFork.tab.sessionId, "switch-target");
    switchTarget.appendMessage({ role: "user", content: "switched prompt", timestamp: Date.now() });
    switchTarget.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "switched reply" }],
      api: MIXCODE_FAUX_MODEL.api,
      provider: MIXCODE_FAUX_MODEL.provider,
      model: MIXCODE_FAUX_MODEL.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const switchFile = switchTarget.getSessionFile();
    assert.ok(switchFile);
    await runtime.prompt(afterFork.tab.sessionId, `/switch-action-session ${switchFile}`);
    const afterSwitch = runtime.listTabs()[0]!;
    assert.equal(afterSwitch.tab.sessionId, "switch-target");
    assert.equal(
      afterSwitch.chat.some((line) => line.role === "user" && line.text === "switched prompt"),
      true,
    );

    assert.ok(events.includes("start:startup"));
    assert.ok(events.includes("new-result:false"));
    assert.ok(events.includes("fork:false"));
    assert.ok(events.includes("switch:false"));
    runtime.setExtensionUiHost(undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension newSession works without optional parent setup or callback", async () => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "mixcode-runtime-extension-new-plain-"),
  );
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    await runtime.createTab(createTab(1, "plain", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const result = await runtime.extensionNewSession("plain");
    const replacement = runtime.listTabs()[0]!;
    assert.equal(result.cancelled, false);
    assert.equal(runtime.getTab("plain"), undefined);
    assert.notEqual(replacement.tab.sessionId, "plain");
    assert.equal(replacement.session.getHeader()?.parentSession, undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension session actions expose cancellation and boundary errors", async () => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "mixcode-runtime-extension-action-boundaries-"),
  );
  let forkCancelEntryId: string | undefined;
  let cancelNextResume = false;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_before_switch", (event) => {
      if (event.reason === "new") return { cancel: true };
      if (event.reason === "resume" && cancelNextResume) return { cancel: true };
      return undefined;
    });
    pi.on("session_before_fork", (event) => {
      if (event.entryId === forkCancelEntryId) return { cancel: true };
      return undefined;
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "root message");
    const userId = runtimeTab.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    const assistantId = runtimeTab.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
    assert.ok(userId);
    assert.ok(assistantId);
    forkCancelEntryId = userId;

    assert.deepEqual(await runtime.extensionNewSession("s1"), { cancelled: true });
    assert.equal(runtime.getTab("s1"), runtimeTab);

    assert.deepEqual(await runtime.extensionFork("s1", userId), { cancelled: true });
    assert.equal(runtime.getTab("s1"), runtimeTab);

    await assert.rejects(() => runtime.extensionFork("s1", "missing-entry"), /Invalid entry ID/);
    await assert.rejects(() => runtime.extensionFork("s1", assistantId), /Invalid entry ID/);
    await assert.rejects(
      () => runtime.extensionSwitchSession("s1", path.join(dir, "missing.jsonl")),
      /Session file not found/,
    );

    const importPath = path.join(dir, "cancel-import.jsonl");
    await fsPromises.writeFile(
      importPath,
      `${JSON.stringify({ type: "session", version: 3, id: "cancel-import", timestamp: "2026-05-10T00:00:00.000Z", cwd: process.cwd() })}\n`,
      "utf8",
    );
    cancelNextResume = true;
    assert.deepEqual(await runtime.importFromJsonl("s1", importPath), { cancelled: true });
    assert.equal(runtime.getTab("s1"), runtimeTab);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

async function createCwdProject(root: string, name: string, outputPad: number): Promise<string> {
  const cwd = path.join(root, name);
  await Bun.write(path.join(cwd, "marker.txt"), name);
  await Bun.write(path.join(cwd, "AGENTS.md"), `Project context: ${name}_ONLY_CONTEXT`);
  await Bun.write(path.join(cwd, ".pi/settings.json"), JSON.stringify({ outputPad }));
  await Bun.write(path.join(cwd, ".pi/prompts", `${name}-prompt.md`), `${name} prompt`);
  await Bun.write(
    path.join(cwd, ".pi/extensions/project.ts"),
    `export default (pi) => pi.registerCommand("${name}-only", { handler: async () => {} });`,
  );
  return cwd;
}

function createCwdSession(cwd: string, sessionDir: string) {
  const target = SessionManager.create(cwd, sessionDir);
  target.appendModelChange(MIXCODE_FAUX_MODEL.provider, MIXCODE_FAUX_MODEL.id);
  target.appendThinkingLevelChange("off");
  target.appendSessionInfo("Target session");
  target.appendMessage({ role: "user", content: "Target history", timestamp: Date.now() });
  target.appendMessage(fauxAssistantMessage("Stored response"));
  return target;
}

for (const operation of ["switch", "import", "import-override"] as const) {
  test(`${operation} binds extension contexts, resources, and relative tools to the target cwd`, async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-cwd-"));
    const events: Array<{ event: string; cwd: string; sessionCwd: string }> = [];
    const extension: ExtensionFactory = (pi) => {
      pi.on("session_start", (event, ctx) => {
        events.push({
          event: `start:${event.reason}`,
          cwd: ctx.cwd,
          sessionCwd: ctx.sessionManager.getCwd(),
        });
      });
      pi.on("session_shutdown", (_event, ctx) => {
        events.push({ event: "shutdown", cwd: ctx.cwd, sessionCwd: ctx.sessionManager.getCwd() });
      });
      pi.registerCommand("switch-cwd", {
        handler: async (args, ctx) => {
          await ctx.switchSession(args, {
            withSession: async (replacement) => {
              events.push({
                event: "withSession",
                cwd: replacement.cwd,
                sessionCwd: replacement.sessionManager.getCwd(),
              });
            },
          });
        },
      });
    };
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(root, "sessions"),
      agentDir: path.join(root, "agent"),
      extensionFactories: [extension],
    });
    try {
      const sourceCwd = await createCwdProject(root, "source", 1);
      const targetCwd = await createCwdProject(root, "target", 0);
      const stored = createCwdSession(
        operation === "import-override" ? sourceCwd : targetCwd,
        path.join(root, "external-sessions"),
      );
      const targetFile = stored.getSessionFile()!;
      const source = await runtime.createTab(createTab(1, "source", sourceCwd), {
        workdir: sourceCwd,
        systemPrompt: "Session cwd test",
        model: MIXCODE_FAUX_MODEL,
        thinkingLevel: "medium",
      });
      if (operation === "switch") {
        await runtime.prompt(source.tab.sessionId, `/switch-cwd ${targetFile}`);
      } else {
        await runtime.importFromJsonl(
          source.tab.sessionId,
          targetFile,
          operation === "import-override" ? targetCwd : undefined,
        );
      }
      const replacement = runtime.getTab(stored.getSessionId())!;
      assert.ok(replacement);
      assert.deepEqual(events, [
        { event: "start:startup", cwd: sourceCwd, sessionCwd: sourceCwd },
        { event: "shutdown", cwd: sourceCwd, sessionCwd: sourceCwd },
        { event: "start:resume", cwd: targetCwd, sessionCwd: targetCwd },
        ...(operation === "switch"
          ? [{ event: "withSession", cwd: targetCwd, sessionCwd: targetCwd }]
          : []),
      ]);
      assert.equal(replacement.tab.workdir, targetCwd);
      assert.equal(replacement.services.settingsManager.getOutputPad(), 0);
      const commandNames = runtime
        .getExtensionCommands(replacement.tab.sessionId)
        .map((command) => command.name);
      assert.ok(commandNames.includes("target-only"));
      assert.ok(commandNames.includes("switch-cwd"));
      assert.equal(commandNames.includes("source-only"), false);
      assert.deepEqual(
        replacement.services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name),
        ["target-prompt"],
      );
      assert.match(replacement.agentSession.systemPrompt, /target_ONLY_CONTEXT/);
      assert.doesNotMatch(replacement.agentSession.systemPrompt, /source_ONLY_CONTEXT/);
      assert.ok(
        replacement.chat.some((line) => line.role === "user" && line.text === "Target history"),
      );
      assert.equal(replacement.tab.title, "Target session");
      assert.equal(replacement.agentSession.model?.id, MIXCODE_FAUX_MODEL.id);
      const tools = replacement.agentSession.agent.state.tools;
      const read = tools.find((tool) => tool.name === "read")!;
      const write = tools.find((tool) => tool.name === "write")!;
      const bash = tools.find((tool) => tool.name === "bash")!;
      assert.deepEqual((await read.execute("cwd-read", { path: "marker.txt" })).content, [
        { type: "text", text: "target" },
      ]);
      await write.execute("cwd-write", { path: "marker.txt", content: "changed in target" });
      assert.equal(await Bun.file(path.join(targetCwd, "marker.txt")).text(), "changed in target");
      assert.equal(await Bun.file(path.join(sourceCwd, "marker.txt")).text(), "source");
      const shellResult = await bash.execute("cwd-bash", { command: "pwd" });
      assert.deepEqual(shellResult.content, [{ type: "text", text: `${targetCwd}\n` }]);
    } finally {
      await runtime.closeAllTabs();
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });
}

test("cancelled cross-directory resume keeps source resources and never loads target extensions", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-cwd-cancel-"));
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    extensionFactories: [
      (pi) => {
        pi.on("session_before_switch", () => ({ cancel: true }));
      },
    ],
  });
  try {
    const sourceCwd = await createCwdProject(root, "source", 1);
    const targetCwd = await createCwdProject(root, "target", 0);
    const loadedMarker = path.join(root, "target-loaded");
    await Bun.write(
      path.join(targetCwd, ".pi/extensions/project.ts"),
      `import * as fs from "node:fs"; export default () => fs.writeFileSync(${JSON.stringify(loadedMarker)}, "loaded");`,
    );
    const stored = createCwdSession(targetCwd, path.join(root, "external-sessions"));
    await runtime.createTab(createTab(1, "source", sourceCwd), {
      workdir: sourceCwd,
      systemPrompt: "Session cwd test",
      model: MIXCODE_FAUX_MODEL,
    });
    assert.deepEqual(await runtime.extensionSwitchSession("source", stored.getSessionFile()!), {
      cancelled: true,
    });
    assert.equal(await Bun.file(loadedMarker).exists(), false);
    const read = runtime
      .getTab("source")!
      .agentSession.agent.state.tools.find((tool) => tool.name === "read")!;
    assert.deepEqual((await read.execute("source-read", { path: "marker.txt" })).content, [
      { type: "text", text: "source" },
    ]);
    assert.ok(
      runtime.getExtensionCommands("source").some((command) => command.name === "source-only"),
    );
  } finally {
    await runtime.closeAllTabs();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
