import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { activateMixCodeTools } from "../src/agent/tools.js";
import { isExtensionToolOwner } from "../src/core/extension-tool-owners.js";
import { createTab, MixCodeRuntime } from "../src/index.js";

function builtinNamedExtension(toolName: string): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: toolName,
      label: `Extension ${toolName}`,
      description: `Extension-owned ${toolName}`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "extension" }], details: {} }),
    });
  };
}

async function createRuntimeWithBuiltinNameExtension(toolName: string) {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-extension-tool-owner-"));
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    extensionFactories: [builtinNamedExtension(toolName)],
  });
  const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  return { dir, runtime, runtimeTab };
}

async function createRuntimeWithLocalPiToolDisplay(toolName: string) {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-pi-tool-display-owner-"));
  const extensionDir = join(dir, "pi-tool-display");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "index.ts"),
    `import { Type } from "@earendil-works/pi-ai";\n` +
      `export default function extension(pi) {\n` +
      `  pi.registerTool({\n` +
      `    name: ${JSON.stringify(toolName)},\n` +
      `    label: "wrapped",\n` +
      `    description: "pi-tool-display wrapped tool",\n` +
      `    parameters: Type.Object({}),\n` +
      `    execute: async () => ({ content: [{ type: "text", text: "wrapped" }], details: {} })\n` +
      `  });\n` +
      `}\n`,
    "utf8",
  );

  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    additionalExtensionPaths: [join(extensionDir, "index.ts")],
  });
  const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  return { dir, runtime, runtimeTab };
}

async function createRuntimeWithDeferredBuiltinNameExtension(toolName: string) {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-deferred-builtin-extension-"));
  const extensionDir = join(dir, "ordinary-extension");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "index.ts"),
    `import { Type } from "@earendil-works/pi-ai";\n` +
      `export default function extension(pi) {\n` +
      `  pi.on("session_start", () => {\n` +
      `    pi.registerTool({\n` +
      `      name: ${JSON.stringify(toolName)},\n` +
      `      label: "deferred",\n` +
      `      description: "deferred extension tool",\n` +
      `      parameters: Type.Object({}),\n` +
      `      execute: async () => ({ content: [{ type: "text", text: "deferred" }], details: {} })\n` +
      `    });\n` +
      `  });\n` +
      `}\n`,
    "utf8",
  );

  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    additionalExtensionPaths: [join(extensionDir, "index.ts")],
  });
  const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  return { dir, runtime, runtimeTab };
}

async function createRuntimeWithDeferredLocalPiToolDisplay() {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-pi-tool-display-deferred-owner-"));
  const extensionDir = join(dir, "pi-tool-display");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "index.ts"),
    `import { Type } from "@earendil-works/pi-ai";\n` +
      `export default function extension(pi) {\n` +
      `  pi.registerTool({\n` +
      `    name: "ls",\n` +
      `    label: "wrapped ls",\n` +
      `    description: "pi-tool-display wrapped ls",\n` +
      `    parameters: Type.Object({}),\n` +
      `    execute: async () => ({ content: [{ type: "text", text: "wrapped ls" }], details: {} })\n` +
      `  });\n` +
      `  pi.on("session_start", () => {\n` +
      `    pi.registerTool({\n` +
      `      name: "bash",\n` +
      `      label: "wrapped bash",\n` +
      `      description: "pi-tool-display wrapped bash",\n` +
      `      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),\n` +
      `      execute: async () => ({ content: [{ type: "text", text: "wrapped bash" }], details: {} })\n` +
      `    });\n` +
      `  });\n` +
      `}\n`,
    "utf8",
  );

  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    additionalExtensionPaths: [join(extensionDir, "index.ts")],
  });
  const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  return { dir, runtime, runtimeTab };
}

test("public tool source metadata owns builtin names when private definitions are stale", () => {
  const extensionDefinition = { name: "extension-read" };
  const toolDefinitions = new Map([
    ["read", { definition: extensionDefinition, sourceInfo: { source: "builtin" } }],
  ]);
  const session = {
    _cwd: process.cwd(),
    _toolDefinitions: toolDefinitions,
    _toolRegistry: new Map(),
    _toolPromptGuidelines: new Map(),
    _toolPromptSnippets: new Map(),
    settingsManager: {
      getImageAutoResize: () => true,
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
    },
    getAllTools: () => [
      {
        name: "read",
        description: "extension read",
        parameters: {},
        sourceInfo: { source: "cli", path: "/extension/index.ts" },
      },
    ],
    getActiveToolNames: () => [],
    setActiveToolsByName: () => undefined,
  };

  activateMixCodeTools(session as never, isExtensionToolOwner);

  assert.equal(toolDefinitions.get("read")?.definition, extensionDefinition);
});

test("ordinary extensions own builtin tool names by default", async () => {
  const { dir, runtime, runtimeTab } = await createRuntimeWithBuiltinNameExtension("ls");
  try {
    const tool = runtime.getExtensionTools("s1").find((tool) => tool.name === "ls");
    assert.ok(tool);
    assert.equal(tool.sourceInfo?.source, "inline");
    assert.equal(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" &&
          line.text.includes("Extension tool conflict: ls") &&
          line.text.includes("shadowed by Pi builtin tool ls"),
      ),
      false,
    );
    assert.match(runtimeTab.tab.startupSummary ?? "", /ls -> inline/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ordinary deferred extensions own builtin tool names", async () => {
  const { dir, runtime, runtimeTab } = await createRuntimeWithDeferredBuiltinNameExtension("bash");
  try {
    const tool = runtime.getExtensionTools("s1").find((tool) => tool.name === "bash");
    assert.ok(tool);
    assert.equal(tool.sourceInfo?.source, "cli");
    assert.match(runtimeTab.tab.startupSummary ?? "", /bash -> cli/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi-tool-display style wrappers own builtin tool names without user config", async () => {
  const { dir, runtime, runtimeTab } = await createRuntimeWithLocalPiToolDisplay("ls");
  try {
    const tool = runtime.getExtensionTools("s1").find((tool) => tool.name === "ls");
    assert.ok(tool);
    assert.equal(tool.sourceInfo?.source, "cli");
    assert.match(tool.sourceInfo?.path ?? "", /pi-tool-display\/index\.ts$/);
    assert.equal(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" &&
          line.text.includes("Extension tool conflict: ls") &&
          line.text.includes("shadowed by Pi builtin tool ls"),
      ),
      false,
    );
    assert.match(runtimeTab.tab.startupSummary ?? "", /\[Tool Owners\]/);
    assert.match(runtimeTab.tab.startupSummary ?? "", /ls -> cli/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deferred pi-tool-display bash owners appear in startup summary", async () => {
  const { dir, runtime, runtimeTab } = await createRuntimeWithDeferredLocalPiToolDisplay();
  try {
    const bash = runtime.getExtensionTools("s1").find((tool) => tool.name === "bash");
    assert.ok(bash);
    assert.equal(bash.sourceInfo?.source, "cli");
    const startup = runtimeTab.tab.startupSummary ?? "";
    assert.match(startup, /\[Tool Owners\]/);
    assert.match(startup, /ls -> cli/);
    assert.match(startup, /bash -> cli/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
