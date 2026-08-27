import "./helpers/isolated-agent-dir.js";
// Regression tests: the startup resource summary ([Context]/[Skills]/[Extensions])
// lives on tab.startupSummary (a tab-level field, Pi's loadedResourcesContainer
// analogue) instead of inside the chat array. Chat rebuilds from session entries
// (retract, tree navigation, compaction) therefore can never clear it.

import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  type AssistantMessage,
  type Context,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createTab,
  type MixCodeModel,
} from "./helpers/mixcode.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// Stream that stays open until aborted or released, so a run is genuinely
// mid-flight with zero visible output when retracted.
function pendingStream(release: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "hdr-test",
      provider: "hdr-test",
      model: "hdr-test-model",
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
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    await Promise.race([
      release,
      new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    const aborted = {
      ...message,
      stopReason: "aborted" as const,
      errorMessage: "Request was aborted",
    };
    if (options?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

test("startup summary survives retractCurrentTurn (double-Esc undo)", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-hdr-retract-"));
  try {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_m: MixCodeModel, _c: Context, options?: SimpleStreamOptions) =>
        pendingStream(released, options),
    });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: { ...MIXCODE_FAUX_MODEL, provider: "hdr-test", api: "hdr-test", id: "hdr-test-model" },
    });
    const summaryBefore = runtimeTab.tab.startupSummary;
    assert.ok(summaryBefore, "startup summary is set on tab after createTab");
    assert.match(summaryBefore, /\[Context\]/);

    const pending = runtime.prompt("s1", "please retract me");
    await waitFor(() => runtimeTab.agentSession.agent.state.isStreaming === true);
    const result = await runtime.retractCurrentTurn("s1");
    release();
    await pending.catch(() => undefined);

    assert.equal(result?.editorText, "please retract me");
    assert.equal(runtimeTab.tab.startupSummary, summaryBefore);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("startup summary survives extension tree navigation", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-hdr-tree-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: MIXCODE_FAUX_MODEL,
    });
    const summaryBefore = runtimeTab.tab.startupSummary;
    assert.ok(summaryBefore);

    await runtime.prompt("s1", "first message");
    await waitFor(() => runtimeTab.agentSession.agent.state.isStreaming === false);
    const userEntry = runtimeTab.session
      .getBranch()
      .find((e) => e.type === "message" && e.message.role === "user");
    assert.ok(userEntry);

    await runtime.extensionNavigateTree("s1", userEntry.id);
    assert.equal(runtimeTab.tab.startupSummary, summaryBefore);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("startup summary renders at the top of the agent surface and contains resources", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-hdr-render-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: MIXCODE_FAUX_MODEL,
    });
    assert.ok(runtimeTab.tab.startupSummary);
    // Chat is now a pure projection of session entries plus runtime notices:
    // the startup summary itself never appears as a chat line.
    assert.equal(
      runtimeTab.chat.some((line) => line.text.includes("[Context]")),
      false,
    );

    // Tall viewport so the whole summary fits without scrolling.
    const lines = renderAgentSurface(runtimeTab.tab, runtimeTab, 100, 400).map(stripAnsi);
    const joined = lines.join("\n");
    assert.match(joined, /\[Context\]/);
    assert.match(joined, /\[Extensions\]/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("extension load errors land in the startup summary diagnostics section", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-hdr-diag-"));
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
    assert.ok(
      runtimeTab.services.resourceLoader
        .getExtensions()
        .errors.some((error) => error.path === extensionPath),
    );
    assert.match(runtimeTab.tab.startupSummary ?? "", /\[Diagnostics\]/);
    assert.match(runtimeTab.tab.startupSummary ?? "", /Extension load error/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("skill name collisions render a [Skill conflicts] section like Pi", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-hdr-skill-conflict-"));
  const home = process.env.HOME ?? dir;
  const winnerPath = path.join(home, ".pi/agent/skills/dup-skill/SKILL.md");
  const loserPath = path.join(home, ".agents/skills/dup-skill/SKILL.md");
  const winnerBaseDir = path.join(home, ".pi/agent/skills/dup-skill");
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      resourceLoaderOptions: {
        // Inject a Pi-shaped skill-collision diagnostic plus the surviving skill
        // so the header formatter can resolve the winner's source label.
        skillsOverride: () => ({
          skills: [
            {
              name: "dup-skill",
              description: "duplicate skill",
              filePath: winnerPath,
              baseDir: winnerBaseDir,
              sourceInfo: {
                path: winnerPath,
                source: "auto",
                scope: "user",
                origin: "top-level",
                baseDir: winnerBaseDir,
              },
              disableModelInvocation: false,
            },
          ],
          diagnostics: [
            {
              type: "collision",
              message: 'name "dup-skill" collision',
              path: loserPath,
              collision: {
                resourceType: "skill",
                name: "dup-skill",
                winnerPath,
                loserPath,
              },
            },
          ],
        }),
      },
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const summary = runtimeTab.tab.startupSummary ?? "";
    assert.match(summary, /\[Skill conflicts\]/);
    assert.match(summary, /"dup-skill" collision:/);
    // Winner shows its source label + path exactly once.
    assert.match(summary, /✓ auto \(user\) ~\/\.pi\/agent\/skills\/dup-skill\/SKILL\.md/);
    // Loser is marked skipped with its (source-less) display path.
    assert.match(summary, /✗ ~\/\.agents\/skills\/dup-skill\/SKILL\.md \(skipped\)/);
    const winnerLines = summary.split("\n").filter((line) => line.includes("✓"));
    assert.equal(winnerLines.length, 1, "winner path appears exactly once");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("no [Skill conflicts] section when there are no skill diagnostics", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-hdr-skill-clean-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      // Force an empty diagnostics set so the assertion does not depend on the
      // host machine's real skill collisions.
      resourceLoaderOptions: {
        skillsOverride: (base) => ({ skills: base.skills, diagnostics: [] }),
      },
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.doesNotMatch(runtimeTab.tab.startupSummary ?? "", /\[Skill conflicts\]/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("skill conflicts render package source labels and non-collision diagnostics", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-hdr-skill-pkg-"));
  const home = process.env.HOME ?? dir;
  // npm package skill: baseDir + npm: source drives getShortPath's relative path
  // and getDisplaySourceInfo's accent (source + scope) label branch.
  const pkgBaseDir = path.join(home, ".pi/agent/npm/node_modules/pi-skills/skills/pkg-skill");
  const winnerPath = path.join(pkgBaseDir, "SKILL.md");
  const loserPath = path.join(home, "project/.agents/skills/pkg-skill/SKILL.md");
  const warnPath = path.join(home, ".agents/skills/bad-skill/SKILL.md");
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      resourceLoaderOptions: {
        skillsOverride: () => ({
          skills: [
            {
              name: "pkg-skill",
              description: "package skill",
              filePath: winnerPath,
              baseDir: pkgBaseDir,
              sourceInfo: {
                path: winnerPath,
                source: "npm:pi-skills",
                scope: "user",
                origin: "package",
                baseDir: pkgBaseDir,
              },
              disableModelInvocation: false,
            },
          ],
          diagnostics: [
            {
              type: "collision",
              message: 'name "pkg-skill" collision',
              path: loserPath,
              collision: {
                resourceType: "skill",
                name: "pkg-skill",
                winnerPath,
                loserPath,
              },
            },
            // Non-collision diagnostic (validation warning) exercises the
            // path + message "others" branch.
            {
              type: "warning",
              message: "name contains invalid characters",
              path: warnPath,
            },
          ],
        }),
      },
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const summary = runtimeTab.tab.startupSummary ?? "";
    assert.match(summary, /\[Skill conflicts\]/);
    // Winner: accent label "npm:pi-skills (user)" + package-relative short path.
    assert.match(summary, /✓ npm:pi-skills \(user\) SKILL\.md/);
    // Loser has no loaded sourceInfo -> plain ~-relative display path.
    assert.match(summary, /✗ ~\/project\/\.agents\/skills\/pkg-skill\/SKILL\.md \(skipped\)/);
    // Non-collision warning renders path line then message line.
    assert.match(
      summary,
      /~\/\.agents\/skills\/bad-skill\/SKILL\.md\n\s+name contains invalid characters/,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
