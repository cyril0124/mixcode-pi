import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  AuthStorage,
  getMarkdownTheme,
  ModelRegistry,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  TUI,
  visibleWidth,
  type AutocompleteProvider,
  type Component,
  type OverlayOptions,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  MixCodeRuntime,
  box,
  createInitialState,
  createTab,
  createMixCodeTui,
  MIXCODE_KEYMAP,
  describeScopedKeymap,
  describeKeymap,
  handleSubmittedInput,
  mixcodeFauxStream,
  padLine,
  renderChat,
  renderCommandPalette,
  renderConfig,
  renderExportChooser,
  renderExportText,
  renderSystemToolsText,
  renderExtensionFooter,
  renderExtensionHeader,
  renderExtensionWidgets,
  renderHeader,
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
  renderSidebar,
  renderStatus,
  renderTabBar,
  renderTabJumpOverlay,
  renderThinking,
  renderWorkingIndicator,
  fitHeadLines,
  fitTailLines,
  titledBox,
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
      pendingUserInteractions: [],
      workingVisible: true,
    },
  });

  const lines = renderExtensionWidgets(tab, 48, "aboveEditor");
  const plain = lines.map(stripAnsi);
  const normalized = plain.join(" ").replace(/\s+/g, " ").trim();

  assert.ok(lines.length > 1);
  assert.equal(plain.some((line) => line.includes("...")), false);
  assert.match(normalized, /with message\./);
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
      pendingUserInteractions: [],
      workingVisible: true,
      header: { lines: [], render: (width) => [fullWidthLine("header", width)] },
      footer: { lines: [], render: (width) => [fullWidthLine("footer", width)] },
    },
  });

  const header = renderExtensionHeader(tab, 48);
  const footer = renderExtensionFooter(tab, 48);

  assert.equal(header.length, 1);
  assert.equal(footer.length, 1);
  assert.equal(stripAnsi(header[0] ?? "").endsWith("|"), true);
  assert.equal(stripAnsi(footer[0] ?? "").endsWith("|"), true);
  assert.equal(stripAnsi(header.join("\n")).includes("..."), false);
  assert.equal(stripAnsi(footer.join("\n")).includes("..."), false);
  assert.equal(header.every((line) => visibleWidth(line) <= 48), true);
  assert.equal(footer.every((line) => visibleWidth(line) <= 48), true);
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
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-ui-noop-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
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

    assert.deepEqual(runtimeTab.tab.extensionUi.statuses, [{ key: "status", text: "ready" }]);
    assert.equal(runtimeTab.tab.extensionUi.workingMessage, "Delegating");
    assert.equal(runtimeTab.tab.extensionUi.workingVisible, false);
    assert.deepEqual(runtimeTab.tab.extensionUi.workingIndicatorFrames, ["⠋"]);
    assert.equal(runtimeTab.tab.extensionUi.workingIndicatorIntervalMs, 75);
    assert.equal(runtimeTab.tab.extensionUi.hiddenThinkingLabel, "Delegated thinking...");
    assert.equal(runtimeTab.tab.extensionUi.toolsExpanded, true);
    assert.deepEqual(
      runtimeTab.tab.extensionUi.widgets
        .filter((widget) => widget.key !== "bg-sessions")
        .map((widget) => ({
          key: widget.key,
          placement: widget.placement,
          lines: widget.lines.map(stripAnsi),
        })),
      [
        { key: "above", placement: "aboveEditor", lines: ["above widget"] },
        { key: "below", placement: "belowEditor", lines: ["below widget"] },
        {
          key: "factory",
          placement: "aboveEditor",
          lines: [
            "factory widget 120",
            "line-0",
            "line-1",
            "line-2",
            "line-3",
            "line-4",
            "line-5",
            "line-6",
            "line-7",
            "line-8",
            "... (widget truncated)",
          ],
        },
      ],
    );
    assert.deepEqual(events, []);
    assert.deepEqual(
      runtimeTab.tab.extensionUi.header?.lines.map((line) => stripAnsi(line).trim()),
      ["header 120"],
    );
    assert.deepEqual(
      runtimeTab.tab.extensionUi.footer?.lines.map((line) => stripAnsi(line).trim()),
      ["footer 120 status=ready"],
    );
    const narrowHeader = renderExtensionHeader(runtimeTab.tab, 8);
    assert.equal(narrowHeader.length, 1);
    assert.equal(visibleWidth(narrowHeader[0] ?? ""), 8);
    assert.equal(stripAnsi(narrowHeader.join("\n")).trim(), "header 8");
    const narrowFooter = renderExtensionFooter(runtimeTab.tab, 8);
    assert.equal(narrowFooter.length, 1);
    assert.equal(visibleWidth(narrowFooter[0] ?? ""), 8);
    assert.match(stripAnsi(narrowFooter.join("\n")), /foote\.\.\./);
    assert.match(renderInputMeta(runtimeTab.tab, 100).join("\n"), /\n ready\s*$/);
    assert.match(
      renderExtensionWidgets(runtimeTab.tab, 100, "aboveEditor").join("\n"),
      /above widget/,
    );
    assert.match(
      renderExtensionWidgets(runtimeTab.tab, 100, "aboveEditor").join("\n"),
      /widget truncated/,
    );
    assert.match(
      renderExtensionWidgets(runtimeTab.tab, 100, "belowEditor").join("\n"),
      /below widget/,
    );
    assert.deepEqual(renderWorkingIndicator({ ...runtimeTab.tab, status: "running" }, 100), []);
    assert.equal(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" &&
          line.text.includes("Pi extension UI primitive is not wired in MixCode yet: setStatus"),
      ),
      false,
    );
    assert.equal(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" &&
          line.text.includes(
            "Pi extension UI primitive is not wired in MixCode yet: setWorkingIndicator",
          ),
      ),
      false,
    );
    assert.equal(
      runtimeTab.chat.some(
        (line) =>
          line.role === "system" &&
          line.text.includes(
            "Pi extension UI primitive is not wired in MixCode yet: setHiddenThinkingLabel",
          ),
      ),
      false,
    );

    runtimeTab.agentSession.extensionRunner.getUIContext().setWorkingIndicator();
    runtimeTab.agentSession.extensionRunner.getUIContext().setHiddenThinkingLabel();
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("missing", undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("below", ["replacement"]);
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("above", undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setHeader(undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setFooter(undefined);
    runtimeTab.agentSession.extensionRunner.getUIContext().setWidget("factory", undefined);
    assert.equal(runtimeTab.tab.extensionUi.workingIndicatorFrames, undefined);
    assert.equal(runtimeTab.tab.extensionUi.workingIndicatorIntervalMs, undefined);
    assert.equal(runtimeTab.tab.extensionUi.hiddenThinkingLabel, undefined);
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
    assert.equal(runtimeTab.tab.extensionUi.header, undefined);
    assert.equal(runtimeTab.tab.extensionUi.footer, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime maps extension theme primitives to MixCode themes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-theme-"));
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
      tui: new TUI(silentTerminal()),
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

    assert.match(seen[0] ?? "", /\x1b\[/);
    assert.match(seen[0] ?? "", /accent-ok/);
    assert.match(seen[1] ?? "", /mixcode-extension/);
    assert.match(seen[2] ?? "", /theme-ok/);
    assert.equal(seen[3], "missing-ok");
    assert.match(
      seen[4] ?? "",
      /^false:Pi extension theme switching requires an active MixCode TUI host/,
    );
    assert.deepEqual(light, { success: false, error: "Unknown theme: light" });
    assert.deepEqual(dark, { success: true });
    assert.deepEqual(appliedThemes, ["mixcode-dark"]);
    assert.equal(mixTheme, "mixcode-dark");
    assert.equal(ui.theme, runtimeTab.agentSession.extensionRunner.getUIContext().theme);
    assert.match(missing.error ?? "", /Unknown theme: missing-theme/);
    assert.equal(
      runtimeTab.chat.some((line) =>
        line.text.includes("Pi extension UI primitive is not wired in MixCode yet: theme"),
      ),
      false,
    );
    assert.equal(
      runtimeTab.chat.some((line) =>
        line.text.includes("Pi extension UI primitive is not wired in MixCode yet: getAllThemes"),
      ),
      false,
    );
    assert.equal(
      runtimeTab.chat.some((line) =>
        line.text.includes("Pi extension UI primitive is not wired in MixCode yet: getTheme"),
      ),
      false,
    );
    assert.equal(
      runtimeTab.chat.some((line) =>
        line.text.includes("Pi extension UI primitive is not wired in MixCode yet: setTheme"),
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime dispatches pi extension terminal input handlers in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-input-"));
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
    await rm(dir, { recursive: true, force: true });
  }
});
