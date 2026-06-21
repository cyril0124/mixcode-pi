import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  bootstrapMixCode,
  createInitialState,
  createTab,
  defaultMixCodeAgentDir,
  defaultPiAgentDir,
  defaultPiAuthPath,
  defaultPiModelsPath,
  defaultStateDir,
  UUIDV7_SESSION_ID_PATTERN,
  saveStateFile,
  scopedStateDir,
  stateFileForPort,
} from "../src/index.js";
import { exposeLocalPiCli, parseMainArgs } from "../src/cli/main.js";

test("bootstrap creates initial state and persists it when no state exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-"));
  try {
    const { state, runtime, stateFile, tabsReady } = await bootstrapMixCode({
      workdir: dir,
      stateDir: dir,
      port: 7,
      modelConfigPath: join(dir, "missing.jsonc"),
    });
    assert.equal(state.tabs.length, 1);
    assert.match(state.tabs[0]!.sessionId, UUIDV7_SESSION_ID_PATTERN);
    await tabsReady;
    assert.ok(runtime.getTab(state.tabs[0]!.sessionId));
    assert.equal(stateFile, stateFileForPort(scopedStateDir(dir, dir), 7));
    assert.deepEqual(state.packageUpdates, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap restores persisted tab order and runtime tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-restore-"));
  try {
    const repo = join(dir, "repo");
    await mkdir(repo, { recursive: true });
    const state = createInitialState(repo);
    state.tabs.push(createTab(1, "s1", repo), createTab(2, "s2", repo));
    state.activeTabId = "s2";
    await saveStateFile(stateFileForPort(scopedStateDir(dir, "/fallback"), 0), state, 0);
    const restored = await bootstrapMixCode({
      workdir: "/fallback",
      stateDir: dir,
      modelConfigPath: join(dir, "missing.jsonc"),
    });
    assert.deepEqual(
      restored.state.tabs.map((tab) => tab.sessionId),
      ["s1", "s2"],
    );
    assert.equal(restored.state.activeTabId, "config");
    await restored.tabsReady;
    assert.ok(restored.runtime.getTab("s1"));
    assert.ok(restored.runtime.getTab("s2"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap maintains global history files and exposes paths in prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-history-"));
  try {
    const stateDir = join(dir, "state");
    const repo = join(dir, "repo");
    const sessionsRoot = join(scopedStateDir(stateDir, repo), "sessions");
    await mkdir(repo, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      join(sessionsRoot, "2026-06-20T00-00-00-000Z_s1.jsonl"),
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
      modelConfigPath: join(dir, "missing.jsonc"),
    });
    await boot.tabsReady;
    const runtimeTab = boot.runtime.getTab(boot.state.tabs[0]!.sessionId);
    assert.ok(runtimeTab);
    assert.match(await readFile(join(stateDir, "history.jsonl"), "utf8"), /hello boot/);
    assert.match(await readFile(join(stateDir, "session_index.jsonl"), "utf8"), /"id":"s1"/);
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDir, "history.jsonl"))).mode & 0o777, 0o600);
    assert.match(runtimeTab.agent.state.systemPrompt, /Local conversation history:/);
    assert.match(runtimeTab.agent.state.systemPrompt, new RegExp(`${stateDir.replace(/[\\\\/]/g, "[\\\\/]")}[/\\\\]history\\.jsonl`));
    assert.doesNotMatch(runtimeTab.agent.state.systemPrompt, /stores full session transcripts under/);
    assert.doesNotMatch(runtimeTab.agent.state.systemPrompt, /hello boot/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap builds completion sources from project files and skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-completion-"));
  try {
    await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "review", "SKILL.md"),
      "description: review",
      "utf8",
    );
    await mkdir(join(dir, ".agents", "skills", "parallelize"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "parallelize", "SKILL.md"),
      [
        "---",
        'description: Parallelize decomposable work via subagents. Trigger: "parallelize"',
        "---",
        "# Parallelize",
        "Fallback body description.",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(dir, ".agents", "skills", "broken"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "broken", "SKILL.md"),
      "---\ndescription: [\n---\n",
      "utf8",
    );
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "", "utf8");
    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: join(dir, "state"),
      homeDir: join(dir, "home"),
      modelConfigPath: join(dir, "missing.jsonc"),
    });
    assert.deepEqual(boot.completionSources.skills, [
      {
        name: "parallelize",
        path: join(dir, ".agents", "skills", "parallelize", "SKILL.md"),
        description: "Fallback body description.",
      },
      {
        name: "review",
        path: join(dir, ".agents", "skills", "review", "SKILL.md"),
        description: "review",
      },
    ]);
    assert.ok(boot.completionSources.files.includes("src/index.ts"));
    assert.equal(
      boot.workspaceFile,
      join(scopedStateDir(join(dir, "state"), dir), "workspaces.json"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default pi model paths stay compatible with pi agent config", () => {
  const oldPiDir = process.env.PI_CODING_AGENT_DIR;
  const oldMixCodeDir = process.env.MIXCODE_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
    delete process.env.MIXCODE_CODING_AGENT_DIR;
    assert.equal(defaultPiAgentDir(), "/tmp/pi-agent");
    assert.equal(defaultPiModelsPath(), "/tmp/pi-agent/models.json");
    assert.equal(defaultPiAuthPath(), "/tmp/pi-agent/auth.json");
    assert.equal(defaultMixCodeAgentDir(), "/tmp/pi-agent");

    process.env.PI_CODING_AGENT_DIR = "";
    assert.equal(defaultPiAgentDir(), join(homedir(), ".pi", "agent"));
    assert.equal(defaultPiModelsPath(), join(homedir(), ".pi", "agent", "models.json"));
    assert.equal(defaultPiAuthPath(), join(homedir(), ".pi", "agent", "auth.json"));
    assert.equal(defaultMixCodeAgentDir(), join(homedir(), ".pi", "agent"));

    process.env.PI_CODING_AGENT_DIR = "~/pi-agent";
    assert.equal(defaultPiAgentDir(), join(homedir(), "pi-agent"));
    assert.equal(defaultPiModelsPath(), join(homedir(), "pi-agent", "models.json"));
    assert.equal(defaultPiAuthPath(), join(homedir(), "pi-agent", "auth.json"));
    assert.equal(defaultMixCodeAgentDir(), join(homedir(), "pi-agent"));

    process.env.MIXCODE_CODING_AGENT_DIR = "";
    assert.equal(defaultMixCodeAgentDir(), join(homedir(), "pi-agent"));

    process.env.MIXCODE_CODING_AGENT_DIR = "~/mix-agent";
    assert.equal(defaultMixCodeAgentDir(), join(homedir(), "mix-agent"));

    process.env.MIXCODE_CODING_AGENT_DIR = "/tmp/mix-agent";
    assert.equal(defaultMixCodeAgentDir(), "/tmp/mix-agent");
  } finally {
    if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPiDir;
    if (oldMixCodeDir === undefined) delete process.env.MIXCODE_CODING_AGENT_DIR;
    else process.env.MIXCODE_CODING_AGENT_DIR = oldMixCodeDir;
  }
});

test("bootstrap selects configured pi models from models.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-pi-model-"));
  const oldKey = process.env.MIXCODE_BOOTSTRAP_KEY;
  try {
    process.env.MIXCODE_BOOTSTRAP_KEY = "secret";
    const modelConfigPath = join(dir, "models.json");
    await writeFile(
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
      stateDir: join(dir, "state"),
      homeDir: join(dir, "home"),
      modelConfigPath,
    });
    assert.equal(boot.state.model.displayName, "mixcode-bootstrap/bootstrap-model");
    assert.equal(boot.state.tabs[0]?.model.displayName, "mixcode-bootstrap/bootstrap-model");
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_BOOTSTRAP_KEY;
    else process.env.MIXCODE_BOOTSTRAP_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap keeps a restored configured model when it is still available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-restored-model-"));
  const oldKey = process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY;
  try {
    process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY = "secret";
    const stateDir = join(dir, "state");
    const repo = join(dir, "repo");
    const modelConfigPath = join(dir, "models.json");
    await mkdir(repo, { recursive: true });
    await writeFile(
      modelConfigPath,
      JSON.stringify({
        providers: {
          "mixcode-bootstrap-restore": {
            baseUrl: "https://bootstrap-restore.example/v1",
            api: "openai-responses",
            apiKey: "MIXCODE_BOOTSTRAP_RESTORE_KEY",
            models: [
              { id: "restore-model", contextWindow: 99 },
              { id: "tab-model", contextWindow: 123 },
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
        },
        contextLimit: 1,
        thinkingLevel: "xhigh",
      }),
    );
    await saveStateFile(stateFileForPort(scopedStateDir(stateDir, repo), 0), state, 0);

    const boot = await bootstrapMixCode({
      workdir: repo,
      stateDir,
      homeDir: join(dir, "home"),
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
    assert.equal(boot.state.tabs[1]?.thinkingLevel, "xhigh");
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY;
    else process.env.MIXCODE_BOOTSTRAP_RESTORE_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap wires pi model registry and extension options into runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-extension-"));
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
    const modelConfigPath = join(dir, "models.json");
    await writeFile(
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
      stateDir: join(dir, "state"),
      homeDir: join(dir, "home"),
      modelConfigPath,
      agentDir: join(dir, "agent"),
      extensionFactories: [extension],
    });
    await boot.tabsReady;
    const runtimeTab = boot.runtime.getTab(boot.state.tabs[0]!.sessionId);
    assert.ok(runtimeTab);
    assert.equal(runtimeTab.agent.state.model.provider, "mixcode-bootstrap-extension");
    assert.ok(
      runtimeTab.agentSession.modelRegistry.find(
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
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap wires configured pi models into runtime auth streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-runtime-auth-"));
  const oldKey = process.env.MIXCODE_BOOTSTRAP_STREAM_KEY;
  try {
    process.env.MIXCODE_BOOTSTRAP_STREAM_KEY = "stream-secret";
    const modelConfigPath = join(dir, "models.json");
    await writeFile(
      modelConfigPath,
      JSON.stringify({
        providers: {
          "mixcode-bootstrap-stream": {
            baseUrl: "https://bootstrap-stream.example/v1",
            api: "openai-responses",
            apiKey: "MIXCODE_BOOTSTRAP_STREAM_KEY",
            models: [{ id: "stream-model", contextWindow: 128 }],
          },
        },
      }),
      "utf8",
    );

    const boot = await bootstrapMixCode({
      workdir: dir,
      stateDir: join(dir, "state"),
      homeDir: join(dir, "home"),
      modelConfigPath,
    });

    const tab = boot.state.tabs[0]!;
    await boot.tabsReady;
    const runtimeTab = boot.runtime.getTab(tab.sessionId);
    assert.ok(runtimeTab);
    assert.equal(runtimeTab.agent.state.model.provider, "mixcode-bootstrap-stream");
    assert.equal(runtimeTab.agent.state.model.id, "stream-model");
    assert.equal(runtimeTab.agent.state.model.api, "openai-responses");
    assert.equal(
      await runtimeTab.agentSession.modelRegistry.getApiKeyForProvider("mixcode-bootstrap-stream"),
      "stream-secret",
    );
    assert.ok(
      runtimeTab.agentSession.modelRegistry.find("mixcode-bootstrap-stream", "stream-model"),
    );
  } finally {
    if (oldKey === undefined) delete process.env.MIXCODE_BOOTSTRAP_STREAM_KEY;
    else process.env.MIXCODE_BOOTSTRAP_STREAM_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap repairs persisted tabs that reference unavailable models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-unavailable-model-"));
  try {
    const stateDir = join(dir, "state");
    const repo = join(dir, "repo");
    await mkdir(repo, { recursive: true });
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
    await saveStateFile(stateFileForPort(scopedStateDir(stateDir, repo), 0), state, 0);

    const boot = await bootstrapMixCode({
      workdir: repo,
      stateDir,
      modelConfigPath: join(dir, "missing.jsonc"),
    });

    assert.equal(boot.state.model.displayName, "faux/faux-1");
    assert.equal(boot.state.tabs[0]?.model.displayName, "faux/faux-1");
    assert.equal(boot.state.tabs[0]?.contextLimit, 200_000);
    await boot.tabsReady;
    assert.ok(boot.runtime.getTab("s1"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default state dir follows XDG_CONFIG_HOME", () => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
  try {
    assert.equal(defaultStateDir(), "/tmp/xdg-test/mixcode-pi");
    delete process.env.XDG_CONFIG_HOME;
    assert.match(defaultStateDir(), /\/\.config\/mixcode-pi$/);
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
});

test("bootstrap uses default state dir and port when omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-defaults-"));
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  try {
    const boot = await bootstrapMixCode({
      workdir: dir,
      homeDir: join(dir, "home"),
      modelConfigPath: join(dir, "missing.jsonc"),
    });
    assert.equal(
      boot.stateFile,
      join(scopedStateDir(join(dir, "xdg", "mixcode-pi"), dir), "mixcode_state.json"),
    );
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap surfaces invalid persisted state errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bootstrap-invalid-state-"));
  try {
    const stateDir = join(dir, "state");
    const scopedDir = scopedStateDir(stateDir, dir);
    await mkdir(scopedDir, { recursive: true });
    await writeFile(stateFileForPort(scopedDir, 0), "not-json", "utf8");
    await assert.rejects(
      bootstrapMixCode({ workdir: dir, stateDir, modelConfigPath: join(dir, "missing.jsonc") }),
      /Unexpected token|JSON/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli main args keep caller workdir explicit", () => {
  assert.equal(parseMainArgs([], "/tmp/caller").workdir, "/tmp/caller");
  assert.equal(parseMainArgs(["--workdir", "repo"], "/tmp/caller").workdir, "/tmp/caller/repo");
  assert.equal(parseMainArgs(["--workdir=/tmp/project"], "/tmp/caller").workdir, "/tmp/project");
  assert.throws(() => parseMainArgs(["--workdir"], "/tmp/caller"), /requires a path/);
  assert.throws(() => parseMainArgs(["--unknown"], "/tmp/caller"), /Unknown argument/);
});

test("cli exposes project-local pi binary for extension child processes", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const binDir = exposeLocalPiCli(env, new URL("../src/cli/main.ts", import.meta.url).href);
  assert.equal(env.PATH?.startsWith(`${binDir}:`), true);
  exposeLocalPiCli(env, new URL("../src/cli/main.ts", import.meta.url).href);
  assert.equal(env.PATH?.split(":").filter((part) => part === binDir).length, 1);
});
