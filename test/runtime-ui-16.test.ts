import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  Type,
} from "@earendil-works/pi-ai";
import {
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  MixCodeRuntime,
  createTab,
} from "./helpers/mixcode.js";

test("runtime dispatches pi extension shortcuts and surfaces handler errors", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-shortcuts-"));
  const seen: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerShortcut("ctrl+x", {
      description: "Shortcut smoke",
      handler: (ctx) => {
        seen.push(`hit:${ctx.cwd}`);
        ctx.ui.notify("shortcut hit");
      },
    });
    pi.registerShortcut("ctrl+y", {
      description: "Shortcut failure",
      handler: () => {
        throw new Error("shortcut failed");
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.equal(runtime.dispatchExtensionShortcut("s1", "\x18"), true);
    assert.deepEqual(seen, [`hit:${process.cwd()}`]);
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "system" && line.systemStatus && line.text === "shortcut hit",
      ),
    );
    assert.equal(runtime.dispatchExtensionShortcut("s1", "\x19"), true);
    assert.ok(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" && line.text.includes("Shortcut handler error: shortcut failed"),
      ),
    );
    assert.equal(runtime.dispatchExtensionShortcut("s1", "\x1a"), false);
    assert.equal(runtime.dispatchExtensionShortcut("missing", "\x18"), false);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime reports extension command and shortcut conflicts while extension tools can own builtin names", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-conflict-"));
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("clear", {
      description: "Conflicting local command",
      handler: async () => undefined,
    });
    pi.registerShortcut("ctrl+p", {
      description: "Conflicting shortcut",
      handler: () => undefined,
    });
    pi.registerTool({
      name: "read",
      label: "Read",
      description: "Conflicting MixCode tool.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "extension" }], details: {} }),
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    // Conflict diagnostics now surface in the startup header's [Diagnostics]
    // section instead of chat system lines.
    const summary = runtimeTab.tab.startupSummary ?? "";
    assert.ok(summary.includes("Extension command conflict: /clear"));
    assert.ok(summary.includes("Extension tool override: read"));
    assert.ok(summary.includes("Extension shortcut 'ctrl+p'"));
    assert.equal(
      runtime.getExtensionCommands("s1").some((command) => command.name === "clear"),
      true,
    );
    assert.equal(
      runtimeTab.agentSession.getToolDefinition("read")?.description,
      "Conflicting MixCode tool.",
    );
    assert.match(runtimeTab.tab.startupSummary ?? "", /read -> inline/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime surfaces pi extension load errors explicitly", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-load-error-"));
  const extensionPath = path.join(dir, "missing-extension.ts");
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      additionalExtensionPaths: [extensionPath],
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.ok(runtimeTab.services.resourceLoader.getExtensions().errors.some((error) => error.path === extensionPath));
    // Load errors surface in the startup header's [Diagnostics] section.
    assert.match(runtimeTab.tab.startupSummary ?? "", /\[Diagnostics\]/);
    assert.ok(
      (runtimeTab.tab.startupSummary ?? "").includes(`Extension load error: ${extensionPath}`),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime loads pi package resources from project package sources", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-package-extension-"));
  try {
    const packageRoot = path.join(dir, "package");
    const extensionPath = path.join(packageRoot, "src", "extension", "index.ts");
    await fsPromises.mkdir(path.join(packageRoot, "src", "extension"), { recursive: true });
    await fsPromises.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "mixcode-package-extension",
        type: "module",
        pi: { extensions: ["./src/extension/index.ts"] },
      }),
      "utf8",
    );
    await fsPromises.writeFile(
      extensionPath,
      [
        "export default function extension(pi) {",
        "  pi.registerCommand('pkg-smoke', { description: 'Package command', handler: async () => {} });",
        "  pi.registerTool({",
        "    name: 'pkg_tool',",
        "    label: 'Pkg',",
        "    description: 'Package manifest tool',",
        "    parameters: { type: 'object', properties: {}, required: [] },",
        "    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const agentDir = path.join(dir, "agent");
    const workdir = path.join(dir, "repo");
    await fsPromises.mkdir(workdir, { recursive: true });
    const settings = SettingsManager.create(workdir, agentDir);
    settings.setProjectPackages([packageRoot]);
    await settings.flush();

    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir,
      settingsManager: settings,
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", workdir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir,
    });

    assert.ok(runtimeTab.agentSession.getAllTools().some((tool) => tool.name === "pkg_tool"));
    assert.ok(runtime.getExtensionCommands("s1").some((command) => command.name === "pkg-smoke"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime updates streaming assistant content in place", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  const baseMessage = {
    role: "assistant" as const,
    content: [] as Array<{ type: "text"; text: string }>,
    api: "x" as const,
    provider: "x" as const,
    model: "x",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  anyRuntime.applyEvent(runtimeTab, { type: "message_start", message: baseMessage });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: {
      ...baseMessage,
      content: [{ type: "text", text: "partial answer" }],
      usage: { ...baseMessage.usage, input: 3, output: 4, totalTokens: 7 },
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "partial answer",
      partial: {},
    },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_end",
    message: {
      ...baseMessage,
      content: [{ type: "text", text: "final answer" }],
      usage: { ...baseMessage.usage, input: 5, output: 6, totalTokens: 11 },
    },
  });

  assert.deepEqual(
    runtimeTab.chat.filter((line) => line.role === "assistant").map((line) => line.text),
    ["final answer"],
  );
  assert.equal(tab.currentContextTokens, 11);
});
