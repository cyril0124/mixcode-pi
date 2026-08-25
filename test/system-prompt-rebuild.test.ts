import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildMixCodeSystemPromptSections, createTab, MixCodeRuntime } from "./helpers/mixcode.js";

const GUIDELINE = "Always call frobnicate before defrobbing.";

function guidelineToolExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "frobnicate",
      label: "Frobnicate",
      description: "A tool with a distinctive prompt guideline",
      parameters: Type.Object({}),
      promptSnippet: "run frobnicate",
      promptGuidelines: [GUIDELINE],
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  };
}

async function createRuntimeTab() {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-system-prompt-rebuild-"));
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    agentDir: path.join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    extensionFactories: [guidelineToolExtension()],
  });
  const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  return { dir, runtime, runtimeTab };
}

test("MixCode system prompt includes active tool promptGuidelines", async () => {
  const { dir, runtimeTab } = await createRuntimeTab();
  try {
    // Builtin read/edit/write guidelines are Pi-provided and must survive.
    assert.match(
      runtimeTab.agentSession.agent.state.systemPrompt,
      /Use read to examine files instead of cat or sed\./,
    );
    assert.match(
      runtimeTab.agentSession.agent.state.systemPrompt,
      /Use write only for new files or complete rewrites\./,
    );
    assert.match(
      runtimeTab.agentSession.agent.state.systemPrompt,
      /- edit: Make precise file edits with exact text replacement/,
    );
    assert.match(
      runtimeTab.agentSession.agent.state.systemPrompt,
      /Each edits\[\]\.oldText is matched against the original file, not after earlier edits are applied/,
    );
    assert.match(
      runtimeTab.agentSession.agent.state.systemPrompt,
      /Keep edits\[\]\.oldText as small as possible while still being unique in the file\. Do not pad with large unchanged regions\./,
    );
    assert.match(
      runtimeTab.agentSession.agent.state.systemPrompt,
      /Use bash for file operations like ls, rg, find/,
    );
    // Extension-provided guideline for the active custom tool must be present.
    assert.match(runtimeTab.agentSession.agent.state.systemPrompt, new RegExp(GUIDELINE.replace(/\./g, "\\.")));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("edit guidelines stay complete even without forwarded tool metadata", () => {
  const prompt = buildMixCodeSystemPromptSections({
    selectedTools: ["edit"],
    cwd: process.cwd(),
  }).prompt;
  assert.match(prompt, /Use edit for precise changes \(edits\[\]\.oldText must match exactly\)/);
  assert.match(
    prompt,
    /When changing multiple separate locations in one file, use one edit call with multiple entries in edits\[\]/,
  );
  assert.match(
    prompt,
    /Each edits\[\]\.oldText is matched against the original file, not after earlier edits are applied/,
  );
  assert.match(
    prompt,
    /Keep edits\[\]\.oldText as small as possible while still being unique in the file/,
  );
});

test("documentation pointers never reference a path that is missing on disk", () => {
  const prompt = buildMixCodeSystemPromptSections({ selectedTools: ["read"], cwd: process.cwd() }).prompt;
  const section = /\nDocumentation \([^\n]*\n((?:- [^\n]*\n?)+)/.exec(prompt)?.[1] ?? "";
  const paths = [...section.matchAll(/^- [^:]+: (\S+)/gm)].map((m) => m[1] as string);

  // A source checkout always ships docs/, so the section must not be vacuous here.
  assert.ok(
    paths.some((p) => p.endsWith("/docs")),
    `expected a MixCode docs pointer, got: ${section}`,
  );
  for (const p of paths) {
    assert.ok(existsSync(p), `system prompt points at a missing path: ${p}`);
  }
});

test("an unrelated docs directory is not reported as Pi's documentation", async () => {
  // getPackageDir() falls back to the executable's directory in compiled
  // binaries, so any stray sibling `docs/` must not be advertised as pi's.
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-fake-package-"));
  const previous = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = dir;
  try {
    await fsPromises.mkdir(path.join(dir, "docs"));
    await fsPromises.writeFile(path.join(dir, "docs", "something.md"), "not pi");
    await fsPromises.writeFile(path.join(dir, "README.md"), "not pi");

    const prompt = buildMixCodeSystemPromptSections({
      selectedTools: ["read"],
      cwd: process.cwd(),
    }).prompt;
    assert.doesNotMatch(prompt, new RegExp(`Pi docs: ${dir}`));
    assert.doesNotMatch(prompt, new RegExp(`Pi overview: ${dir}`));
  } finally {
    if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = previous;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("Pi documentation is resolved from disk when PI_PACKAGE_DIR lacks docs", async () => {
  // Simulate binary mode where PI_PACKAGE_DIR points to a runtimeDir without docs
  const emptyRuntimeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-empty-runtime-"));
  const previous = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = emptyRuntimeDir;
  try {
    const prompt = buildMixCodeSystemPromptSections({
      selectedTools: ["read"],
      cwd: process.cwd(),
    }).prompt;
    // Should still resolve Pi docs from the installed Pi package on disk
    assert.match(prompt, /Pi docs: .*\/docs/);
    assert.doesNotMatch(prompt, new RegExp(`Pi docs: ${emptyRuntimeDir}`));
  } finally {
    if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = previous;
    await fsPromises.rm(emptyRuntimeDir, { recursive: true, force: true });
  }
});

test("Pi-triggered setActiveTools rebuild keeps the MixCode system prompt", async () => {
  const { dir, runtimeTab } = await createRuntimeTab();
  try {
    // MixCode's builder never emits Pi's default "Pi documentation" block.
    assert.doesNotMatch(runtimeTab.agentSession.agent.state.systemPrompt, /Pi documentation/);

    // Simulate an extension calling pi.setActiveTools() at runtime, which makes
    // Pi rebuild the base system prompt via its own builder.
    runtimeTab.agentSession.setActiveToolsByName(
      runtimeTab.agentSession.getActiveToolNames(),
    );

    // After the rebuild the live prompt must still be MixCode's, not Pi's default.
    assert.doesNotMatch(runtimeTab.agentSession.agent.state.systemPrompt, /Pi documentation/);
    assert.match(runtimeTab.agentSession.agent.state.systemPrompt, new RegExp(GUIDELINE.replace(/\./g, "\\.")));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
