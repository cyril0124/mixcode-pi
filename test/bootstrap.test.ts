import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  bootstrapMixCode,
  createInitialState,
  createTab,
  defaultPiAuthPath,
  defaultPiModelsPath,
  defaultPiSessionDir,
  defaultStateDir,
  resolveSessionsRoot,
  saveStateFile,
  scopedStateDir,
  stateFileForPort,
} from "./helpers/mixcode.js";
import { UUIDV7_SESSION_ID_PATTERN } from "./helpers/session-id.js";
import { delegateToRealPiCli, exposeLocalPiCli, parseMainArgs, shouldDelegateToRealPiCli } from "../src/cli/main.js";

test("bootstrap creates initial state and persists it when no state exists", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-"));
  try {
    const { state, runtime, stateFile, tabsReady } = await bootstrapMixCode({
      workdir: dir,
      stateDir: dir,
      port: 7,
      modelConfigPath: path.join(dir, "missing.jsonc"),
    });
    assert.equal(state.tabs.length, 1);
    assert.match(state.tabs[0]!.sessionId, UUIDV7_SESSION_ID_PATTERN);
    await tabsReady;
    assert.ok(runtime.getTab(state.tabs[0]!.sessionId));
    assert.equal(stateFile, stateFileForPort(scopedStateDir(dir, dir), 7));
    assert.deepEqual(state.packageUpdates, []);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap keeps a session-start turn visibly running after tab load", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-running-"));
  let releaseContext!: () => void;
  let markContextEntered!: () => void;
  let contextWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const contextGate = new Promise<void>((resolve) => {
    releaseContext = resolve;
  });
  const contextEntered = new Promise<void>((resolve) => {
    markContextEntered = resolve;
  });
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) return;
      pi.sendMessage(
        { customType: "bootstrap-running", content: "continue", display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    });
    pi.on("context", async (event) => {
      markContextEntered();
      await contextGate;
      return { messages: event.messages };
    });
  };

  let boot: Awaited<ReturnType<typeof bootstrapMixCode>> | undefined;
  try {
    boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      agentDir: path.join(dir, "agent"),
      modelConfigPath: path.join(dir, "missing.jsonc"),
      extensionFactories: [extension],
    });
    await boot.tabsReady;
    await Promise.race([
      contextEntered,
      new Promise<never>((_, reject) => {
        contextWaitTimer = setTimeout(
          () => reject(new Error("bootstrap context event was not observed")),
          10_000,
        );
      }),
    ]);
    clearTimeout(contextWaitTimer);
    contextWaitTimer = undefined;

    const tab = boot.state.tabs[0]!;
    const runtimeTab = boot.runtime.getTab(tab.sessionId);
    assert.ok(runtimeTab?.agentSession.isStreaming);
    assert.ok(tab.status === "running" || tab.status === "thinking");
    assert.ok(tab.workingStartedAt);
  } finally {
    if (contextWaitTimer) clearTimeout(contextWaitTimer);
    boot?.runtime.getTab(boot.state.tabs[0]?.sessionId ?? "")?.agentSession.agent.abort();
    releaseContext();
    await boot?.runtime.getTab(boot.state.tabs[0]?.sessionId ?? "")?.agentSession.waitForIdle();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap restores persisted tab order and runtime tabs", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-restore-"));
  try {
    const repo = path.join(dir, "repo");
    await fsPromises.mkdir(repo, { recursive: true });
    const state = createInitialState(repo);
    state.tabs.push(createTab(1, "s1", repo), createTab(2, "s2", repo));
    state.activeTabId = "s2";
    await saveStateFile(stateFileForPort(scopedStateDir(dir, "/fallback"), 0), state);
    const restored = await bootstrapMixCode({
      workdir: "/fallback",
      stateDir: dir,
      modelConfigPath: path.join(dir, "missing.jsonc"),
    });
    assert.deepEqual(
      restored.state.tabs.map((tab) => tab.sessionId),
      ["s1", "s2"],
    );
    assert.equal(restored.state.activeTabId, "home");
    await restored.tabsReady;
    assert.ok(restored.runtime.getTab("s1"));
    assert.ok(restored.runtime.getTab("s2"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap rejects an invalid persisted theme at the UI boundary", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-theme-"));
  try {
    const repo = path.join(dir, "repo");
    const stateDir = path.join(dir, "state");
    const scopedDir = scopedStateDir(stateDir, repo);
    await fsPromises.mkdir(scopedDir, { recursive: true });
    const state = createInitialState(repo);
    state.theme = "not-a-theme";
    await saveStateFile(stateFileForPort(scopedDir, 0), state);

    await assert.rejects(
      bootstrapMixCode({
        workdir: repo,
        stateDir,
        modelConfigPath: path.join(dir, "missing.jsonc"),
      }),
      /Unknown theme: not-a-theme/,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap maintains global history files and exposes paths in prompt", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-history-"));
  try {
    const stateDir = path.join(dir, "state");
    const agentDir = path.join(dir, "agent");
    const repo = path.join(dir, "repo");
    const sessionsRoot = defaultPiSessionDir(repo, agentDir);
    await fsPromises.mkdir(repo, { recursive: true });
    await fsPromises.mkdir(sessionsRoot, { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionsRoot, "2026-06-20T00-00-00-000Z_s1.jsonl"),
      [
        JSON.stringify({ type: "session", id: "s1", cwd: repo, timestamp: "2026-06-20T00:00:00.000Z" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: "hello boot", timestamp: Date.now() },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const boot = await bootstrapMixCode({
      workdir: repo,
      stateDir,
      agentDir,
      modelConfigPath: path.join(dir, "missing.jsonc"),
    });
    await boot.tabsReady;
    await boot.historyReady;
    const runtimeTab = boot.runtime.getTab(boot.state.tabs[0]!.sessionId);
    assert.ok(runtimeTab);
    assert.match(await fsPromises.readFile(path.join(stateDir, "history.jsonl"), "utf8"), /hello boot/);
    assert.match(await fsPromises.readFile(path.join(stateDir, "session_index.jsonl"), "utf8"), /"id":"s1"/);
    assert.equal((await fsPromises.stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await fsPromises.stat(path.join(stateDir, "history.jsonl"))).mode & 0o777, 0o600);
    assert.match(runtimeTab.agentSession.agent.state.systemPrompt, /Local conversation history:/);
    assert.match(runtimeTab.agentSession.agent.state.systemPrompt, new RegExp(`${stateDir.replace(/[\\\\/]/g, "[\\\\/]")}[/\\\\]history\\.jsonl`));
    assert.doesNotMatch(runtimeTab.agentSession.agent.state.systemPrompt, /stores full session transcripts under/);
    assert.doesNotMatch(runtimeTab.agentSession.agent.state.systemPrompt, /hello boot/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap builds completion sources from Pi-managed fd and skills", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-completion-"));
  try {
    await fsPromises.mkdir(path.join(dir, ".agents", "skills", "review"), { recursive: true });
    await fsPromises.writeFile(
      path.join(dir, ".agents", "skills", "review", "SKILL.md"),
      "---\ndescription: review\n---\n",
      "utf8",
    );
    await fsPromises.mkdir(path.join(dir, ".agents", "skills", "parallelize"), { recursive: true });
    await fsPromises.writeFile(
      path.join(dir, ".agents", "skills", "parallelize", "SKILL.md"),
      [
        "---",
        "description: Parallelize decomposable work via subagents",
        "---",
        "# Parallelize",
        "Fallback body description.",
      ].join("\n"),
      "utf8",
    );
    await fsPromises.mkdir(path.join(dir, ".agents", "skills", "broken"), { recursive: true });
    await fsPromises.writeFile(
      path.join(dir, ".agents", "skills", "broken", "SKILL.md"),
      "---\ndescription: [\n---\n",
      "utf8",
    );
    await fsPromises.mkdir(path.join(dir, "src"), { recursive: true });
    await fsPromises.writeFile(path.join(dir, "src", "index.ts"), "", "utf8");
    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      homeDir: path.join(dir, "home"),
      modelConfigPath: path.join(dir, "missing.jsonc"),
    });
    assert.deepEqual(boot.completionSources.skills, [
      {
        name: "parallelize",
        path: path.join(dir, ".agents", "skills", "parallelize", "SKILL.md"),
        description: "Parallelize decomposable work via subagents",
      },
      {
        name: "review",
        path: path.join(dir, ".agents", "skills", "review", "SKILL.md"),
        description: "review",
      },
    ]);
    assert.equal(typeof boot.completionSources.fdPath, "string");
    assert.equal(
      boot.workspaceFile,
      path.join(scopedStateDir(path.join(dir, "state"), dir), "workspaces.json"),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("default pi model paths stay compatible with pi agent config", () => {
  const oldPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
    assert.equal(getAgentDir(), "/tmp/pi-agent");
    assert.equal(defaultPiModelsPath(), "/tmp/pi-agent/models.json");
    assert.equal(defaultPiAuthPath(), "/tmp/pi-agent/auth.json");

    process.env.PI_CODING_AGENT_DIR = "";
    assert.equal(getAgentDir(), path.join(os.homedir(), ".pi", "agent"));
    assert.equal(defaultPiModelsPath(), path.join(os.homedir(), ".pi", "agent", "models.json"));
    assert.equal(defaultPiAuthPath(), path.join(os.homedir(), ".pi", "agent", "auth.json"));

    process.env.PI_CODING_AGENT_DIR = "~/pi-agent";
    assert.equal(getAgentDir(), path.join(os.homedir(), "pi-agent"));
    assert.equal(defaultPiModelsPath(), path.join(os.homedir(), "pi-agent", "models.json"));
    assert.equal(defaultPiAuthPath(), path.join(os.homedir(), "pi-agent", "auth.json"));
  } finally {
    if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPiDir;
  }
});

test("bootstrap selects configured pi models from models.json", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-pi-model-"));
  const oldKey = process.env.MIXCODE_BOOTSTRAP_KEY;
  try {
    process.env.MIXCODE_BOOTSTRAP_KEY = "secret";
    const modelConfigPath = path.join(dir, "models.json");
    await fsPromises.writeFile(
      modelConfigPath,
      JSON.stringify({
        providers: {
          "mixcode-bootstrap": {
            baseUrl: "https://bootstrap.example/v1",
            api: "openai-responses",
            apiKey: "MIXCODE_BOOTSTRAP_KEY",
            models: [{ id: "bootstrap-model", contextWindow: 42 }],
          },
        },
      }),
      "utf8",
    );
    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      homeDir: path.join(dir, "home"),
      modelConfigPath,
    });
    assert.equal(boot.state.model.displayName, "mixcode-bootstrap/bootstrap-model");
    assert.equal(boot.state.tabs[0]?.model.displayName, "mixcode-bootstrap/bootstrap-model");
    await boot.tabsReady;
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_BOOTSTRAP_KEY;
    else process.env.MIXCODE_BOOTSTRAP_KEY = oldKey;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap keeps a restored configured model when it is still available", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-restored-model-"));
  const oldKey = process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY;
  try {
    process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY = "secret";
    const stateDir = path.join(dir, "state");
    const repo = path.join(dir, "repo");
    const modelConfigPath = path.join(dir, "models.json");
    await fsPromises.mkdir(repo, { recursive: true });
    await fsPromises.writeFile(
      modelConfigPath,
      JSON.stringify({
        providers: {
          "mixcode-bootstrap-restore": {
            baseUrl: "https://bootstrap-restore.example/v1",
            api: "openai-responses",
            apiKey: "MIXCODE_BOOTSTRAP_RESTORE_KEY",
            models: [
              { id: "restore-model", contextWindow: 99 },
              {
                id: "tab-model",
                contextWindow: 123,
                reasoning: true,
                thinkingLevelMap: { max: "max" },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const state = createInitialState(repo);
    state.model = {
      provider: "mixcode-bootstrap-restore",
      modelId: "restore-model",
      displayName: "old display",
      contextWindow: 1,
    };
    state.availableModels = [state.model];
    state.tabs.push(
      createTab(1, "s1", repo, { model: state.model, contextLimit: state.model.contextWindow }),
      createTab(2, "s2", repo, {
        model: {
          provider: "mixcode-bootstrap-restore",
          modelId: "tab-model",
          displayName: "old tab display",
          contextWindow: 1,
          reasoning: true,
          thinkingLevelMap: { max: "max" },
        },
        contextLimit: 1,
        thinkingLevel: "max",
      }),
    );
    await saveStateFile(stateFileForPort(scopedStateDir(stateDir, repo), 0), state);

    const boot = await bootstrapMixCode({
      workdir: repo,
      stateDir,
      homeDir: path.join(dir, "home"),
      modelConfigPath,
    });

    assert.equal(boot.state.model.displayName, "mixcode-bootstrap-restore/restore-model");
    assert.equal(boot.state.model.contextWindow, 99);
    assert.equal(
      boot.state.availableModels.filter((model) => model.modelId === "restore-model").length,
      1,
    );
    assert.equal(boot.state.tabs[0]?.model.displayName, "mixcode-bootstrap-restore/restore-model");
    assert.equal(boot.state.tabs[1]?.model.displayName, "mixcode-bootstrap-restore/tab-model");
    assert.equal(boot.state.tabs[1]?.contextLimit, 123);
    assert.equal(boot.state.tabs[1]?.thinkingLevel, "max");
    await boot.tabsReady;
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY;
    else process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY = oldKey;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap wires pi model registry and extension options into runtime", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-extension-"));
  const oldKey = process.env.MIXCODE_BOOTSTRAP_EXTENSION_KEY;
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "bootstrap_extension_tool",
      label: "Bootstrap",
      description: "Bootstrap extension smoke-test tool.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
    pi.on("session_start", (event) => events.push(event.reason));
  };

  try {
    process.env.MIXCODE_BOOTSTRAP_EXTENSION_KEY = "secret";
    const modelConfigPath = path.join(dir, "models.json");
    await fsPromises.writeFile(
      modelConfigPath,
      JSON.stringify({
        providers: {
          "mixcode-bootstrap-extension": {
            baseUrl: "https://bootstrap-extension.example/v1",
            api: "openai-responses",
            apiKey: "MIXCODE_BOOTSTRAP_EXTENSION_KEY",
            models: [{ id: "bootstrap-extension-model", contextWindow: 128 }],
          },
        },
      }),
      "utf8",
    );

    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      homeDir: path.join(dir, "home"),
      modelConfigPath,
      agentDir: path.join(dir, "agent"),
      extensionFactories: [extension],
    });
    await boot.tabsReady;
    const runtimeTab = boot.runtime.getTab(boot.state.tabs[0]!.sessionId);
    assert.ok(runtimeTab);
    assert.equal(runtimeTab.agentSession.agent.state.model.provider, "mixcode-bootstrap-extension");
    assert.ok(
      runtimeTab.agentSession.modelRuntime.getModel(
        "mixcode-bootstrap-extension",
        "bootstrap-extension-model",
      ),
    );
    assert.ok(
      runtimeTab.agentSession
        .getAllTools()
        .some((tool) => tool.name === "bootstrap_extension_tool"),
    );
    assert.ok(runtimeTab.agentSession.getActiveToolNames().includes("bootstrap_extension_tool"));
    assert.deepEqual(events, ["startup"]);
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_BOOTSTRAP_EXTENSION_KEY;
    else process.env.MIXCODE_BOOTSTRAP_EXTENSION_KEY = oldKey;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap wires configured pi models into runtime auth streaming", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-runtime-auth-"));
  const oldKey = process.env.MIXCODE_BOOTSTRAP_STREAM_KEY;
  try {
    process.env.MIXCODE_BOOTSTRAP_STREAM_KEY = "stream-secret";
    const modelConfigPath = path.join(dir, "models.json");
    await fsPromises.writeFile(
      modelConfigPath,
      JSON.stringify({
        providers: {
          "mixcode-bootstrap-stream": {
            baseUrl: "https://bootstrap-stream.example/v1",
            api: "openai-responses",
            apiKey: "$MIXCODE_BOOTSTRAP_STREAM_KEY",
            models: [{ id: "stream-model", contextWindow: 128 }],
          },
        },
      }),
      "utf8",
    );

    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      homeDir: path.join(dir, "home"),
      modelConfigPath,
    });

    const tab = boot.state.tabs[0]!;
    await boot.tabsReady;
    const runtimeTab = boot.runtime.getTab(tab.sessionId);
    assert.ok(runtimeTab);
    assert.equal(runtimeTab.agentSession.agent.state.model.provider, "mixcode-bootstrap-stream");
    assert.equal(runtimeTab.agentSession.agent.state.model.id, "stream-model");
    assert.equal(runtimeTab.agentSession.agent.state.model.api, "openai-responses");
    assert.equal(
      (await runtimeTab.agentSession.modelRuntime.getAuth("mixcode-bootstrap-stream"))?.auth.apiKey,
      "stream-secret",
    );
    assert.ok(
      runtimeTab.agentSession.modelRuntime.getModel("mixcode-bootstrap-stream", "stream-model"),
    );
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_BOOTSTRAP_STREAM_KEY;
    else process.env.MIXCODE_BOOTSTRAP_STREAM_KEY = oldKey;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap repairs persisted tabs that reference unavailable models", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-unavailable-model-"));
  try {
    const stateDir = path.join(dir, "state");
    const repo = path.join(dir, "repo");
    await fsPromises.mkdir(repo, { recursive: true });
    const state = createInitialState(repo);
    const unavailable = {
      provider: "missing-provider",
      modelId: "missing-model",
      displayName: "missing-provider/missing-model",
      contextWindow: 123,
    };
    state.model = unavailable;
    state.availableModels = [unavailable];
    state.tabs.push(
      createTab(1, "s1", repo, { model: unavailable, contextLimit: unavailable.contextWindow }),
    );
    state.activeTabId = "s1";
    await saveStateFile(stateFileForPort(scopedStateDir(stateDir, repo), 0), state);

    const boot = await bootstrapMixCode({
      workdir: repo,
      stateDir,
      modelConfigPath: path.join(dir, "missing.jsonc"),
    });

    // Unavailable persisted models fall back to the preferred available model
    // (configured ambient/models.json entry, else faux). Do not pin faux: ambient
    // credentials can make built-in providers preferred.
    assert.notEqual(boot.state.model.displayName, "missing-provider/missing-model");
    assert.notEqual(boot.state.tabs[0]?.model.displayName, "missing-provider/missing-model");
    assert.ok(
      boot.state.availableModels.some(
        (model) =>
          model.provider === boot.state.model.provider && model.modelId === boot.state.model.modelId,
      ),
      "repaired model should be present in availableModels",
    );
    assert.equal(boot.state.tabs[0]?.model.displayName, boot.state.model.displayName);
    assert.equal(boot.state.tabs[0]?.contextLimit, boot.state.model.contextWindow);
    await boot.tabsReady;
    assert.ok(boot.runtime.getTab("s1"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("default state dir lives under Pi agent dir and ignores XDG_CONFIG_HOME", () => {
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldPi = process.env.PI_CODING_AGENT_DIR;
  process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
  try {
    assert.equal(defaultStateDir(), "/tmp/pi-agent/mixcode-pi");
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
});

test("bootstrap stores default UI state under Pi agent and sessions in Pi SDK directory", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-defaults-"));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldPi = process.env.PI_CODING_AGENT_DIR;
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "pi-agent");
  try {
    const boot = await bootstrapMixCode({
      workdir: dir,
      homeDir: path.join(dir, "home"),
      modelConfigPath: path.join(dir, "missing.jsonc"),
    });
    assert.equal(
      boot.stateFile,
      path.join(scopedStateDir(path.join(dir, "pi-agent", "mixcode-pi"), dir), "mixcode_state.json"),
    );
    await boot.tabsReady;
    const runtimeTab = boot.runtime.getTab(boot.state.tabs[0]!.sessionId);
    assert.equal(runtimeTab?.session.getSessionDir(), defaultPiSessionDir(dir, path.join(dir, "pi-agent")));
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPi;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap initializes hideThinkingBlock from Pi settings.json", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-hide-thinking-"));
  try {
    const agentDir = path.join(dir, "agent");
    await fsPromises.mkdir(agentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ hideThinkingBlock: true }),
      "utf8",
    );
    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      agentDir,
      modelConfigPath: path.join(dir, "missing.jsonc"),
    });
    assert.equal(boot.state.hideThinkingBlock, true);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap surfaces invalid persisted state errors", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-invalid-state-"));
  try {
    const stateDir = path.join(dir, "state");
    const scopedDir = scopedStateDir(stateDir, dir);
    await fsPromises.mkdir(scopedDir, { recursive: true });
    await fsPromises.writeFile(stateFileForPort(scopedDir, 0), "not-json", "utf8");
    await assert.rejects(
      bootstrapMixCode({ workdir: dir, stateDir, modelConfigPath: path.join(dir, "missing.jsonc") }),
      /Unexpected token|JSON/,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("cli main args keep caller workdir explicit", () => {
  assert.equal(parseMainArgs([], "/tmp/caller").workdir, "/tmp/caller");
  assert.equal(parseMainArgs(["--workdir", "repo"], "/tmp/caller").workdir, "/tmp/caller/repo");
  assert.equal(parseMainArgs(["--workdir=/tmp/project"], "/tmp/caller").workdir, "/tmp/project");
  assert.equal(parseMainArgs([], "/tmp/caller").builtinExtensionsOnly, undefined);
  assert.equal(
    parseMainArgs(["--builtin-extensions-only"], "/tmp/caller").builtinExtensionsOnly,
    true,
  );
  assert.throws(() => parseMainArgs(["--workdir"], "/tmp/caller"), /requires a path/);
  assert.throws(() => parseMainArgs(["--unknown"], "/tmp/caller"), /Unknown argument/);
});

test("bootstrap noExtensions loads explicit extensions without executing discovered extensions", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-builtins-only-"));
  const agentDir = path.join(dir, "agent");
  const explicitMarker = path.join(dir, "explicit-loaded");
  const discoveredMarker = path.join(dir, "discovered-loaded");
  const explicitExtension = path.join(dir, "explicit-extension.js");
  try {
    await fsPromises.mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await fsPromises.writeFile(
      explicitExtension,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(explicitMarker)}, "yes");\nexport default () => {};\n`,
      "utf8",
    );
    await fsPromises.writeFile(
      path.join(agentDir, "extensions", "discovered-extension.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(discoveredMarker)}, "yes");\nexport default () => {};\n`,
      "utf8",
    );

    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      homeDir: path.join(dir, "home"),
      agentDir,
      modelConfigPath: path.join(dir, "missing.jsonc"),
      additionalExtensionPaths: [explicitExtension],
      resourceLoaderOptions: { noExtensions: true },
    });
    await boot.tabsReady;

    assert.equal(await fsPromises.readFile(explicitMarker, "utf8"), "yes");
    await assert.rejects(fsPromises.stat(discoveredMarker), /ENOENT/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("cli exposes project-local pi binary for extension child processes", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const binDir = exposeLocalPiCli(env, new URL("../src/cli/main.ts", import.meta.url).href);
  assert.equal(env.PATH?.startsWith(`${binDir}:`), true);
  exposeLocalPiCli(env, new URL("../src/cli/main.ts", import.meta.url).href);
  assert.equal(env.PATH?.split(":").filter((part) => part === binDir).length, 1);
});

test("cli only delegates when argv explicitly requests --print/-p off a TTY", () => {
  // Valid mixcode-pi grammar never delegates, TTY or not.
  assert.equal(shouldDelegateToRealPiCli([], false), false);
  assert.equal(shouldDelegateToRealPiCli(["--workdir", "."], false), false);
  assert.equal(shouldDelegateToRealPiCli(["status", "--json"], false), false);
  // Explicit --print/-p (pi-coding-agent's own "process prompt and exit" contract,
  // see `pi --help`) off a TTY is the only thing that delegates.
  assert.equal(shouldDelegateToRealPiCli(["-p", "--no-session", "hello"], false), true);
  assert.equal(shouldDelegateToRealPiCli(["--mode", "json", "--print"], false), true);
  // Regression guards for a real vulnerability found while testing: forwarding any
  // argv mixcode-pi's parser merely rejected (without requiring --print/-p) let a
  // bare, flagless prompt silently escalate into a live, fully-tooled pi agent
  // turn when stdin was non-TTY — confirmed by an actual file write in manual
  // testing. Neither shape below may delegate, even though mixcode-pi's own
  // parser rejects both of them too.
  assert.equal(shouldDelegateToRealPiCli(["create a file and write to it"], false), false);
  assert.equal(shouldDelegateToRealPiCli(["--model", "anthropic/claude", "do something"], false), false);
  assert.equal(shouldDelegateToRealPiCli(["--some-future-flag-nobody-guessed"], false), false);
  // Same explicit --print/-p argv, but a human is at an interactive terminal:
  // surface mixcode-pi's own error instead of silently redirecting them elsewhere.
  assert.equal(shouldDelegateToRealPiCli(["-p", "hello"], true), false);
});

test("cli delegates argv and exit code to the real pi CLI", async () => {
  const code = await delegateToRealPiCli(["-e", "process.exit(7)"], { command: process.execPath });
  assert.equal(code, 7);
});

test("cli strips PI_PACKAGE_DIR when delegating to the real pi CLI", async () => {
  // Child must not inherit mixcode binary materialize package dir; that path's
  // package.json rewrote pi identity to mixcode and polluted `pi --help`.
  const code = await delegateToRealPiCli(
    [
      "-e",
      "process.stdout.write(process.env.PI_PACKAGE_DIR === undefined ? 'cleared' : process.env.PI_PACKAGE_DIR); process.exit(process.env.PI_PACKAGE_DIR === undefined ? 0 : 2)",
    ],
    {
      command: process.execPath,
      env: { ...process.env, PI_PACKAGE_DIR: "/tmp/mixcode-pi-must-not-leak" },
    },
  );
  assert.equal(code, 0);
});

test("cli reports exit code 1 when the delegated pi command cannot be spawned", async () => {
  const code = await delegateToRealPiCli([], { command: "definitely-not-a-real-binary-xyz" });
  assert.equal(code, 1);
});

test("resolveSessionsRoot follows Pi precedence: env, settings, default", () => {
  // PI_CODING_AGENT_SESSION_DIR env wins (tilde expanded).
  assert.equal(
    resolveSessionsRoot({
      workdir: "/repo",
      agentDir: "/agent",
      envSessionDir: "/env/sessions",
      settingsSessionDir: "/settings/sessions",
    }),
    "/env/sessions",
  );
  // Then settings.sessionDir.
  assert.equal(
    resolveSessionsRoot({
      workdir: "/repo",
      agentDir: "/agent",
      settingsSessionDir: "/settings/sessions",
    }),
    "/settings/sessions",
  );
  // Finally the per-workdir default under the effective agent dir.
  assert.equal(
    resolveSessionsRoot({
      workdir: "/repo",
      agentDir: "/agent",
    }),
    defaultPiSessionDir("/repo", "/agent"),
  );
});

test("bootstrap derives auth and models from the effective agent dir", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-bootstrap-agentdir-"));
  const oldKey = process.env.MIXCODE_AGENTDIR_STREAM_KEY;
  try {
    process.env.MIXCODE_AGENTDIR_STREAM_KEY = "agentdir-secret";
    const agentDir = path.join(dir, "agent");
    await fsPromises.mkdir(agentDir, { recursive: true });
    // models.json lives under the effective agentDir (no explicit modelConfigPath).
    await fsPromises.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "mixcode-agentdir": {
            baseUrl: "https://agentdir.example/v1",
            api: "openai-responses",
            apiKey: "$MIXCODE_AGENTDIR_STREAM_KEY",
            models: [{ id: "agentdir-model", contextWindow: 128 }],
          },
        },
      }),
      "utf8",
    );

    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: path.join(dir, "state"),
      homeDir: path.join(dir, "home"),
      agentDir,
    });

    // The model from agentDir/models.json is available and configured (auth
    // resolved from the same agentDir), proving both paths follow agentDir.
    assert.ok(
      boot.state.availableModels.some(
        (model) => model.provider === "mixcode-agentdir" && model.modelId === "agentdir-model",
      ),
    );
    await boot.tabsReady;
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_AGENTDIR_STREAM_KEY;
    else process.env.MIXCODE_AGENTDIR_STREAM_KEY = oldKey;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
