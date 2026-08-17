import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, TuiMainScreen, visibleWidth, type AutocompleteProvider, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  MixCodeRuntime,
  box,
  createInitialState,
  createTab,
  createMixCodeTui,
  handleSubmittedInput,
  mixcodeFauxStream,
  padLine,
  renderChat,
  renderCommandPalette,
  renderConfig,
  renderSystemToolsText,
  renderExtensionFooter,
  renderExtensionHeader,
  renderExtensionWidgets,
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
  renderTabBar,
  renderTabJumpOverlay,
  renderWorkingIndicator,
  fitHeadLines,
  fitTailLines,
  themeForId,
} from "../src/index.js";

function delayedAssistantStream(text: string, ready: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message = runtimeAssistantMessage(`Echo: ${text}`);
    await ready;
    if (options?.signal?.aborted) {
      const aborted = {
        ...message,
        content: [],
        stopReason: "aborted" as const,
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...message, content: [{ type: "text", text: "" }] },
    });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: message.content[0]!.text,
      partial: message,
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: message.content[0]!.text,
      partial: message,
    });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function runtimeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "queue-test",
    provider: "queue-test",
    model: "queue-test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function lastRuntimeUserText(context: Context): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((block) => (block.type === "text" ? block.text : "[image]"))
      .join("\n");
  }
  return "";
}

async function waitForRuntime(predicate: () => boolean, attempts = 25): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

async function waitFor(predicate: () => boolean, attempts = 25): Promise<void> {
  await waitForRuntime(predicate, attempts);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("extension string widgets wrap long lines instead of truncating", () => {
  const tab = createTab(1, "s1", "/repo", {
    extensionUi: {
      statuses: [],
      widgets: [
        {
          key: "recap",
          placement: "aboveEditor",
          lines: [
            "recap: Reviewed staged changes, passed git diff --cached --check, and committed skills/grill-me/SKILL.md as 589464f with message.",
          ],
        },
      ],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  });

  const lines = renderExtensionWidgets(tab, 48, "aboveEditor");
  const plain = lines.map(stripAnsi);
  const normalized = plain.join(" ").replace(/\s+/g, " ").trim();

  assert.match(normalized, /with message\./);
  assert.equal(plain.some((line) => line.includes("...")), false);
  assert.equal(lines.every((line) => visibleWidth(line) <= 48), true);
});

test("extension header and footer preserve full-width component output", () => {
  const fullWidthLine = (label: string, width: number) => {
    const prefix = `${label} width=${width} `;
    return `${prefix}${"X".repeat(Math.max(0, width - visibleWidth(prefix) - 1))}|`;
  };
  const tab = createTab(1, "s1", "/repo", {
    extensionUi: {
      statuses: [],
      widgets: [],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
      header: { lines: [], render: (width) => [fullWidthLine("header", width)] },
      footer: { lines: [], render: (width) => [fullWidthLine("footer", width)] },
    },
  });

  const header = renderExtensionHeader(tab, 48);
  const footer = renderExtensionFooter(tab, 48);

  assert.equal(stripAnsi(header[0] ?? "").endsWith("|"), true);
  assert.equal(stripAnsi(footer[0] ?? "").endsWith("|"), true);
  assert.equal(stripAnsi(header.join("\n")).includes("..."), false);
  assert.equal(stripAnsi(footer.join("\n")).includes("..."), false);
});

test("runtime exposes extension UI context as TUI during startup and clear", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-ui-mode-"));
  const modes: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      modes.push(ctx.mode);
      if (ctx.mode !== "tui") return;
      ctx.ui.setHeader(() => ({
        render: () => ["guarded header"],
        invalidate: () => undefined,
      }));
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.deepEqual(modes, ["tui"]);
    assert.deepEqual(renderExtensionHeader(runtimeTab.tab, 80).map((line) => stripAnsi(line).trim()), [
      "guarded header",
    ]);

    const cleared = await runtime.clearTab("s1", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s1-clear",
    });

    assert.deepEqual(modes, ["tui", "tui"]);
    assert.deepEqual(renderExtensionHeader(cleared.tab, 80).map((line) => stripAnsi(line).trim()), [
      "guarded header",
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("clearTab keeps a non-colliding title, never the tab list position", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-clear-title-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [] });
    // Post-close layout: positions no longer match titles (Agent-02 was closed).
    await runtime.createTab(createTab(1, "s1", process.cwd(), { title: "Agent-01" }), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(createTab(2, "s2", process.cwd(), { title: "Agent-03" }), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(createTab(3, "s3", process.cwd(), { title: "Agent-04" }), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const cleared = await runtime.clearTab("s3", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s3-clear",
    });

    // Position index 3 would retitle as "Agent-03", colliding with s2's tab.
    // A generic Agent-NN title must be preserved instead.
    assert.equal(cleared.tab.title, "Agent-04");
    assert.notEqual(
      cleared.tab.title,
      "Agent-03",
      `cleared tab must not take an existing title, got ${cleared.tab.title}`,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("clearTab drops a custom name for the next free generic title", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-clear-custom-title-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [] });
    await runtime.createTab(createTab(1, "s1", process.cwd(), { title: "Agent-01" }), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(createTab(2, "s2", process.cwd(), { title: "Agent-02" }), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(createTab(3, "s3", process.cwd(), { title: "my-project" }), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const cleared = await runtime.clearTab("s3", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s3-clear",
    });

    // Custom names must not carry over to the fresh session; fall back to a
    // free generic title that does not collide with the surviving tabs.
    assert.match(cleared.tab.title, /^Agent-\d{2}$/);
    assert.notEqual(cleared.tab.title, "Agent-01");
    assert.notEqual(cleared.tab.title, "Agent-02");
    assert.notEqual(cleared.tab.title, "my-project");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("runtime maps supported pi extension UI primitives into MixCode tab state", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-ui-noop-"));
  const events: string[] = [];
  const modes: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      modes.push(ctx.mode);
      ctx.ui.setStatus("status", "ready");
      ctx.ui.setStatus("gone", "soon");
      ctx.ui.setStatus("gone", undefined);
      ctx.ui.setWorkingMessage("Delegating");
      ctx.ui.setWorkingVisible(false);
      ctx.ui.setWorkingIndicator({ frames: ["⠋"], intervalMs: 75 });
      ctx.ui.setHiddenThinkingLabel("Delegated thinking...");
      ctx.ui.setToolsExpanded(true);
      ctx.ui.setWidget("above", ["above widget"]);
      ctx.ui.setWidget("below", ["below widget"], { placement: "belowEditor" });
      ctx.ui.setWidget("factory", (tui, theme) => ({
        render: () => {
          tui.terminal.write("x");
          tui.terminal.start(
            () => undefined,
            () => undefined,
          );
          tui.terminal.stop();
          void tui.terminal.drainInput();
          tui.terminal.moveBy(0);
          tui.terminal.hideCursor();
          tui.terminal.showCursor();
          tui.terminal.clearLine();
          tui.terminal.clearFromCursor();
          tui.terminal.clearScreen();
          tui.terminal.setTitle("MixCode");
          tui.terminal.setProgress(false);
          return [
            theme.fg("accent", `factory widget ${tui.terminal.columns}`),
            ...Array.from({ length: 12 }, (_, index) => `line-${index}`),
          ];
        },
        invalidate: () => undefined,
        dispose: () => events.push("factory-dispose"),
      }));
      ctx.ui.setHeader((tui, theme) => ({
        render: () => [theme.fg("accent", `header ${tui.terminal.columns}`)],
        invalidate: () => undefined,
      }));
      ctx.ui.setFooter((tui, theme, footerData) => {
        return {
          render: () => {
            const statuses = [...footerData.getExtensionStatuses()]
              .map(([key, text]) => `${key}=${text}`)
              .join(",");
            return [theme.fg("success", `footer ${tui.terminal.columns} ${statuses}`)];
          },
          invalidate: () => undefined,
        };
      });
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.deepEqual(modes, ["tui"]);
    // Footer is set below, so input-meta collapses; status lives on extensionUi + footer.
    assert.deepEqual(
      runtimeTab.tab.extensionUi.statuses.map((s) => ({ key: s.key, text: s.text })),
      [{ key: "status", text: "ready" }],
    );
    assert.match(
      stripAnsi(renderExtensionFooter(runtimeTab.tab, 100).join("\n")),
      /status=ready/,
    );
    assert.match(
      renderExtensionWidgets(runtimeTab.tab, 100, "aboveEditor").join("\n"),
      /above widget/,
    );
    const aboveWidgets = renderExtensionWidgets(runtimeTab.tab, 100, "aboveEditor").join("\n");
    assert.match(aboveWidgets, /line-11/);
    assert.doesNotMatch(aboveWidgets, /widget truncated/);
    assert.match(
      renderExtensionWidgets(runtimeTab.tab, 100, "belowEditor").join("\n"),
      /below widget/,
    );
    assert.deepEqual(renderWorkingIndicator({ ...runtimeTab.tab, status: "running" }, 100), []);
    assert.equal(stripAnsi(renderExtensionHeader(runtimeTab.tab, 8).join("\n")).trim(), "header 8");
    assert.match(stripAnsi(renderExtensionFooter(runtimeTab.tab, 8).join("\n")), /foote\.\.\./);
    assert.equal(runtimeTab.tab.extensionUi.hiddenThinkingLabel, "Delegated thinking...");
    assert.equal(runtimeTab.tab.extensionUi.toolsExpanded, true);

    runtimeTab.agentSession.extensionRunner.getUIContext().setWorkingIndicator();
    runtimeTab.agentSession.extensionRunner.getUIContext().setHiddenThinkingLabel();
    assert.equal(runtimeTab.tab.extensionUi.hiddenThinkingLabel, undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("missing", undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("below", ["replacement"]);
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("above", undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setHeader(undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setFooter(undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("factory", undefined);
    assert.deepEqual(
      runtimeTab.tab.extensionUi.widgets
        .filter((widget) => widget.key !== "bg-sessions")
        .map((widget) => ({
          key: widget.key,
          lines: widget.lines.map(stripAnsi),
        })),
      [{ key: "below", lines: ["replacement"] }],
    );
    assert.deepEqual(events, ["factory-dispose"]);
    assert.deepEqual(renderExtensionHeader(runtimeTab.tab, 80), []);
    assert.deepEqual(renderExtensionFooter(runtimeTab.tab, 80), []);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps extension theme primitives to MixCode themes", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-theme-"));
  const seen: string[] = [];
  let mixTheme = "mixcode-dark";
  const appliedThemes: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      seen.push(ctx.ui.theme.fg("accent", "accent-ok"));
      seen.push(JSON.stringify(ctx.ui.getAllThemes()));
      seen.push(ctx.ui.getTheme("mixcode-extension")?.fg("success", "theme-ok") ?? "missing-theme");
      seen.push(ctx.ui.getTheme("missing-theme") === undefined ? "missing-ok" : "missing-bad");
      const noHost = ctx.ui.setTheme("light");
      seen.push(`${noHost.success}:${noHost.error}`);
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtime.setExtensionUiHost({
      tui: new TuiMainScreen(silentTerminal()),
      themes: {
        getTheme: () => mixTheme,
        setTheme: (themeId) => {
          mixTheme = themeId;
          appliedThemes.push(themeId);
        },
      },
    });
    const ui = runtimeTab.agentSession.extensionRunner.getUIContext();
    const light = ui.setTheme("light");
    const dark = ui.setTheme("mixcode-dark");
    const missing = ui.setTheme("missing-theme");

    assert.match(seen[0] ?? "", /accent-ok/);
    assert.match(seen[1] ?? "", /mixcode-extension/);
    assert.match(seen[2] ?? "", /theme-ok/);
    assert.equal(seen[3], "missing-ok");
    assert.match(
      seen[4] ?? "",
      /^false:Pi extension theme switching requires an active MixCode TUI host/,
    );
    assert.deepEqual(light, { success: true });
    assert.deepEqual(dark, { success: true });
    assert.deepEqual(appliedThemes, ["light", "mixcode-dark"]);
    assert.equal(mixTheme, "mixcode-dark");
    assert.match(missing.error ?? "", /Unknown theme: missing-theme/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime dispatches pi extension terminal input handlers in order", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-input-"));
  const seen: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.onTerminalInput((data) => {
        seen.push(`one:${JSON.stringify(data)}`);
        return { data: "changed" };
      });
      ctx.ui.onTerminalInput((data) => {
        seen.push(`two:${JSON.stringify(data)}`);
        return data === "changed" ? { consume: true } : undefined;
      });
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    assert.deepEqual(runtime.dispatchTerminalInput("s1", "\x1b"), { consume: true });
    assert.deepEqual(seen, ['one:"\\u001b"', 'two:"changed"']);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
