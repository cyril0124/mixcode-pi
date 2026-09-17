import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type EditorComponent, type TUI as TuiType } from "@earendil-works/pi-tui";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { setExtensionWidget } from "../src/agent/runtime-extension-widgets.js";
import { parseInput } from "../src/core/commands.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeTabInfo } from "../src/core/types.js";
import { serializeState } from "../src/core/state-store.js";
import { activateTab, closeAgentTab } from "../src/core/tabs.js";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "../src/ui/app-editor.js";
import { MixCodeFooterRoot, MixCodeLayoutRoot, MixCodeRoot } from "../src/ui/app-layout.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { OverlayTui } from "../src/ui/app-types.js";
import { buildLabeledTopBorder } from "../src/ui/components/editor-top-border.js";
import {
  renderAgentSurface,
  renderExtensionFooter,
  renderExtensionWidgets,
  renderInlineExtensionWidgets,
} from "../src/ui/rendering.js";
import { renderTabBarSeparator } from "../src/ui/rendering/chrome.js";
import { themeForId } from "../src/ui/themes.js";
import type { EditorSlot as EditorSlotType } from "../src/ui/app-editor.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

const identity = (s: string) => s;

function border(opts: {
  width: number;
  title: string;
  vimMode?: boolean;
  zenMode?: boolean;
}): string {
  return stripAnsi(
    buildLabeledTopBorder({
      width: opts.width,
      title: opts.title,
      vimMode: opts.vimMode === true,
      zenMode: opts.zenMode === true,
      dash: identity,
      vimLabel: identity,
      zenLabel: identity,
      titleLabel: identity,
    }),
  );
}

function widgetTab(overrides: Parameters<typeof createTab>[3] = {}): ReturnType<typeof createTab> {
  return createTab(1, "s1", "/repo", {
    inlineWidgets: true,
    extensionUi: {
      statuses: [],
      widgets: [
        { key: "above", placement: "aboveEditor", lines: ["above"] },
        { key: "below", placement: "belowEditor", lines: ["below"] },
      ],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
    ...overrides,
  });
}

function fakeEditor(lines: string[]): EditorSlotType {
  return {
    render: () => lines,
    invalidate: () => undefined,
    isShowingAutocomplete: () => false,
    setEmbeddedTerminalRows: () => false,
    setEditorMaxRows: () => false,
  } as unknown as EditorSlotType;
}

function buildLayout(viewportRows: number, width = 80) {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs = [tab];
  state.activeTabId = tab.sessionId;
  const runtime = new MixCodeRuntime();
  let editorRows = 0;
  let metaRows = 1;
  const main = new MixCodeRoot(
    state,
    runtime,
    () => viewportRows,
    () => editorRows + metaRows + renderExtensionFooter(tab, width).length,
  );
  const layout = new MixCodeLayoutRoot(
    state,
    main,
    fakeEditor(["editor-line-0", "editor-line-1"]),
    new MixCodeFooterRoot(state),
    (rows) => {
      editorRows = rows;
    },
    (rows) => {
      metaRows = rows;
    },
    () => viewportRows,
    { requestRender: () => undefined },
  );
  return { layout, main, state, tab };
}

function makeSlot() {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Agent-01", inlineWidgets: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    setFocus: () => undefined,
    terminal: { rows: 40, columns: 80 },
  } as unknown as TuiType;
  const defaultEditor = new CompactPromptEditor(
    tui,
    editorThemeFor(themeForId(state.theme)),
    { paddingX: 1 },
    state,
  );
  const slot = new EditorSlot(tui, defaultEditor, state);
  return { state, tab, slot };
}

function stubEditor(lines: string[]): EditorComponent {
  return {
    focused: false,
    borderColor: identity,
    render: () => lines.map((line) => line),
    invalidate: () => undefined,
    handleInput: () => undefined,
    getText: () => "",
    setText: () => undefined,
  } as unknown as EditorComponent;
}

test("parseInput accepts /toggle-inline-widgets", () => {
  assert.deepEqual(parseInput("/toggle-inline-widgets"), {
    kind: "local-command",
    command: "toggle-inline-widgets",
    args: "",
  });
});

test("/toggle-inline-widgets flips inlineWidgets on the active tab", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  assert.equal(tab.inlineWidgets, false);

  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(state, runtime, "/toggle-inline-widgets", tui);
  assert.equal(tab.inlineWidgets, true);

  await handleSubmittedInput(state, runtime, "/toggle-inline-widgets", tui);
  assert.equal(tab.inlineWidgets, false);
});

test("/widgets controls inline widget collapse state by key", async () => {
  const state = createInitialState("/repo");
  const tab = widgetTab();
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(state, runtime, "/widgets expand above", tui);
  assert.equal(tab.inlineWidgetCollapsed.get("above"), false);
  await handleSubmittedInput(state, runtime, "/widgets collapse above", tui);
  assert.equal(tab.inlineWidgetCollapsed.get("above"), true);
  await handleSubmittedInput(state, runtime, "/widgets", tui);
  assert.equal(tab.inlineWidgetCollapsed.get("above"), false);
  assert.equal(tab.inlineWidgetCollapsed.get("below"), false);
});

test("collapsed inline widget header shows its expand command", () => {
  const tab = widgetTab();
  tab.inlineWidgetCollapsed.set("above", true);
  const text = stripAnsi(
    renderAgentSurface(tab, { chat: [{ role: "user", text: "hello-user" }] } as never, 80).join(
      "\n",
    ),
  );
  assert.match(text, /▸ Inline · above .*\/widgets expand above/);
});

test("activateTab keeps inlineWidgets scoped to each tab", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { inlineWidgets: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  activateTab(state, "s2");
  assert.equal(first.inlineWidgets, true);
  assert.equal(second.inlineWidgets, false);
});

test("activateTab to Home keeps inlineWidgets on the agent", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { inlineWidgets: true });
  state.tabs.push(first);
  state.activeTabId = "s1";
  activateTab(state, "home");
  assert.equal(first.inlineWidgets, true);
});

test("closing the active tab keeps the global inline-widgets default", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, inlineWidgets: true };
  const first = createTab(1, "s1", "/repo", { inlineWidgets: true });
  const second = createTab(2, "s2", "/repo", { inlineWidgets: true });
  state.tabs.push(first, second);

  activateTab(state, first.sessionId);
  closeAgentTab(state, first.sessionId);

  assert.equal(state.activeTabId, second.sessionId);
  assert.equal(second.inlineWidgets, true);
});

test("new tabs inherit ui.inlineWidgets from mixcode settings", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, inlineWidgets: true };
  const tab = createTab(1, "s1", "/repo", { inlineWidgets: state.ui?.inlineWidgets === true });
  state.tabs.push(tab);
  assert.equal(tab.inlineWidgets, true);
});

test("serializeState does not persist inlineWidgets", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { inlineWidgets: true }));
  assert.doesNotMatch(JSON.stringify(serializeState(state)), /inlineWidgets/);
});

test("inline widgets use a surface wash that dock widgets do not", () => {
  const tab = widgetTab();
  const inline = renderAgentSurface(
    tab,
    { chat: [{ role: "user", text: "hello-user" }] } as never,
    80,
  ).join("\n");
  const dock = renderExtensionWidgets(tab, 80, "aboveEditor").join("\n");
  assert.match(inline, /\x1b\[48;/);
  assert.doesNotMatch(dock, /\x1b\[48;/);
  assert.match(stripAnsi(inline), /above/);
});

test("inline widgets sit after messages and before the queue preview", () => {
  const tab = widgetTab({ pendingMessages: ["steer-me"] });
  const text = stripAnsi(
    renderAgentSurface(tab, { chat: [{ role: "user", text: "hello-user" }] } as never, 80).join(
      "\n",
    ),
  );
  const userAt = text.indexOf("hello-user");
  const aboveAt = text.indexOf("above");
  const belowAt = text.indexOf("below");
  const steerAt = text.indexOf("Steer");
  assert.ok(userAt >= 0 && aboveAt > userAt, "above widget follows the message");
  assert.ok(belowAt > aboveAt, "below widget follows above widget");
  assert.ok(steerAt > belowAt, "queue stays below widgets");
});

test("a new message does not push inline widgets above the chat tail", () => {
  const tab = widgetTab({ pendingMessages: ["steer-me"] });
  const chat = [
    { role: "user" as const, text: "first-msg" },
    { role: "user" as const, text: "second-msg" },
  ];
  const text = stripAnsi(renderAgentSurface(tab, { chat } as never, 80).join("\n"));
  assert.ok(text.indexOf("second-msg") < text.indexOf("above"));
  assert.ok(text.indexOf("below") < text.indexOf("Steer"));
});

test("scrolling up moves the queue then inline widgets off the bottom", () => {
  const chat = Array.from({ length: 20 }, (_, i) => ({
    role: "user" as const,
    text: `msg-${String(i).padStart(2, "0")}`,
  }));
  const tab = widgetTab({ pendingMessages: ["steer-me"] });
  const bottom = stripAnsi(renderAgentSurface(tab, { chat } as never, 80, 8).join("\n"));
  assert.match(bottom, /above/);
  assert.match(bottom, /below/);
  assert.match(bottom, /Steer/);

  tab.chatScrollOffset = 1_000_000;
  const top = stripAnsi(renderAgentSurface(tab, { chat } as never, 80, 8).join("\n"));
  assert.match(top, /msg-00/);
  assert.doesNotMatch(top, /above|below|Steer/);
});

test("windowed inline widgets stay between messages and the queue", () => {
  const chat = Array.from({ length: 60 }, (_, i) => ({
    role: "user" as const,
    text: `long-${String(i).padStart(2, "0")}`,
  }));
  const tab = widgetTab({ pendingMessages: ["steer-me"] });
  const text = stripAnsi(renderAgentSurface(tab, { chat } as never, 80, 20).join("\n"));
  const last = text.indexOf("long-59");
  const aboveAt = text.indexOf("▸ Inline · above");
  const belowAt = text.indexOf("▸ Inline · below");
  const steerAt = text.indexOf("Steer");
  assert.ok(last >= 0 && aboveAt > last);
  assert.ok(belowAt > aboveAt && steerAt > belowAt);
});

test("full and windowed tails leave the same gap between widgets and the queue", () => {
  const make = (chat: Array<{ role: "user"; text: string }>, height?: number) =>
    stripAnsi(
      renderAgentSurface(
        widgetTab({ pendingMessages: ["steer-me"] }),
        { chat } as never,
        80,
        height,
      ).join("\n"),
    );
  const gap = (text: string) => {
    const start = text.indexOf("below");
    const end = text.indexOf("Steer");
    assert.ok(start >= 0 && end > start);
    return text.slice(start, end).split("\n").length;
  };
  const short = make([{ role: "user", text: "hello-user" }]);
  const long = make(
    Array.from({ length: 70 }, (_, i) => ({
      role: "user" as const,
      text: `long-${String(i).padStart(2, "0")}`,
    })),
    16,
  );
  assert.equal(gap(short), gap(long));
});

test("vim keeps inline widgets in the chat tail with the queue", () => {
  const tab = widgetTab({ vimMode: true, pendingMessages: ["steer-me"] });
  const text = stripAnsi(
    renderAgentSurface(tab, { chat: [{ role: "user", text: "hello-user" }] } as never, 80).join(
      "\n",
    ),
  );
  assert.match(text, /above/);
  assert.match(text, /below/);
  assert.match(text, /Steer/);
  assert.ok(text.indexOf("below") < text.indexOf("Steer"));
});

test("an open side panel keeps widgets out of the chat tail", () => {
  const tab = widgetTab({ panelOpen: true, pendingMessages: ["steer-me"] });
  const text = stripAnsi(
    renderAgentSurface(tab, { chat: [{ role: "user", text: "hello-user" }] } as never, 80).join(
      "\n",
    ),
  );
  assert.doesNotMatch(text, /above|below/);
  assert.match(text, /Steer/);
});

test("inline mode removes docked widgets and grows the chat surface", () => {
  const { layout, tab } = buildLayout(24);
  tab.extensionUi.widgets = [
    { key: "above", placement: "aboveEditor", lines: ["above body"] },
    { key: "below", placement: "belowEditor", lines: ["below body"] },
  ];

  layout.render(80);
  const docked = layout.render(80);
  const dockedChat = tab.chatSurfaceBounds?.height ?? 0;
  assert.match(stripAnsi(docked.join("\n")), /above/);

  tab.inlineWidgets = true;
  layout.render(80);
  const inlined = layout.render(80);
  const inlinedText = stripAnsi(inlined.join("\n"));
  const inlinedChat = tab.chatSurfaceBounds?.height ?? 0;
  assert.match(inlinedText, /above/);
  assert.match(inlinedText, /editor-line-0/);
  assert.equal(inlinedText.split("above body").length - 1, 1, "widgets must not render twice");
  assert.ok(inlinedChat > dockedChat, `chat should grow: ${inlinedChat} vs ${dockedChat}`);
});

test("inline widgets stay in the chat column, not the editor dock", () => {
  const { layout, main, tab } = buildLayout(24);
  tab.extensionUi.widgets = [{ key: "above", placement: "aboveEditor", lines: ["above body"] }];

  const dockedMain = stripAnsi(main.render(80).join("\n"));
  assert.doesNotMatch(dockedMain, /above/);

  tab.inlineWidgets = true;
  const inlinedMain = stripAnsi(main.render(80).join("\n"));
  assert.match(inlinedMain, /above/);

  layout.render(80);
  const full = stripAnsi(layout.render(80).join("\n"));
  assert.equal(full.split("above body").length - 1, 1);
});

test("inline mode labels the widget header", () => {
  const line = border({ width: 40, title: "Agent-1" });
  assert.match(line, /Agent-1/);

  const tab = widgetTab();
  const text = stripAnsi(renderAgentSurface(tab, { chat: [] } as never, 80).join("\n"));
  assert.match(text, /▸ Inline · above/);
});

test("VIM and ZEN badges remain in the editor border", () => {
  const line = border({
    width: 56,
    title: "Agent-1",
    vimMode: true,
    zenMode: true,
  });
  assert.match(line, /^── \[VIM\] \[ZEN\] /);
});

test("narrow borders keep VIM/ZEN or the title", () => {
  const line = border({
    width: 18,
    title: "Agent-1",
    vimMode: true,
    zenMode: true,
  });
  assert.match(line, /\[VIM\]|\[ZEN\]|Agent-1/);
});

test("default editor chrome shows the agent title", () => {
  const { slot } = makeSlot();
  const plain = stripAnsi(slot.render(64).join("\n"));
  assert.match(plain, /Agent-01/);
});

test("setEditorComponent takeover suppresses the agent chrome", () => {
  const { slot } = makeSlot();
  const width = 56;
  const plainTop = "─".repeat(width);
  slot.setEditorComponent(() => stubEditor([plainTop, " plugin-body ", plainTop]));
  const body = stripAnsi(slot.render(width).join("\n"));
  assert.match(body, /plugin-body/);
  assert.doesNotMatch(body, /Agent-01/);

  const separator = stripAnsi(
    renderTabBarSeparator(width, {
      agentChrome: { title: "Agent-01" },
    }).join("\n"),
  );
  assert.match(separator, /Agent-01/);
});

test("temporary input override suppresses the agent chrome", () => {
  const { slot, state } = makeSlot();
  slot.setInputComponent(
    {
      render: () => ["dialog body"],
      invalidate: () => undefined,
      handleInput: () => undefined,
    },
    state.activeTabId,
  );
  const plain = stripAnsi(slot.render(40).join("\n"));
  assert.match(plain, /dialog body/);
  assert.doesNotMatch(plain, /Agent-01/);
});

test("custom()/dialog takeover suppresses the agent chrome", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    title: "Agent-01",
    inlineWidgets: true,
    extensionUi: {
      statuses: [],
      widgets: [],
      toolsExpanded: false,
      waitingForInputs: [{ id: "c1", kind: "custom" }],
      workingVisible: true,
    },
  });
  state.tabs = [tab];
  state.activeTabId = "s1";
  const runtime = new MixCodeRuntime();
  const main = new MixCodeRoot(
    state,
    runtime,
    () => 24,
    () => 4,
    () => true,
  );

  const during = stripAnsi(main.render(80).join("\n"));
  assert.match(during, /Agent-01/);

  const restored = stripAnsi(main.render(80).join("\n"));
  assert.match(restored, /Agent-01/);
});

test("setInputComponent takeover suppresses the agent chrome", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Agent-01", inlineWidgets: true });
  state.tabs = [tab];
  state.activeTabId = "s1";
  const runtime = new MixCodeRuntime();
  const main = new MixCodeRoot(
    state,
    runtime,
    () => 24,
    () => 4,
    () => true,
    () => true,
  );

  const during = stripAnsi(main.render(80).join("\n"));
  assert.match(during, /Agent-01/);
});

test("turning inline widgets off restores the dock", () => {
  const { layout, main, tab } = buildLayout(24);
  tab.extensionUi.widgets = [{ key: "above", placement: "aboveEditor", lines: ["above"] }];
  tab.inlineWidgets = true;
  layout.render(80);
  assert.match(stripAnsi(main.render(80).join("\n")), /above/);

  tab.inlineWidgets = false;
  layout.render(80);
  assert.doesNotMatch(stripAnsi(main.render(80).join("\n")), /above/);
  assert.match(stripAnsi(layout.render(80).join("\n")), /above/);
});

test("zen + custom editor keeps status dots and the agent title", () => {
  const line = stripAnsi(
    renderTabBarSeparator(64, {
      zenMode: true,
      zenStatusMarkers: ["working", "done"],
      agentChrome: { title: "Agent-17" },
    }).join("\n"),
  );
  assert.match(line, /●/);
  assert.match(line, /Agent-17/);
});

test("anchored chat still places widgets before the queue", () => {
  const tab = widgetTab({
    pendingMessages: ["steer-me"],
    chatScrollAnchorEntryId: "e1",
  });
  const chat = [
    { role: "user" as const, text: "hello-user", entryId: "e1" },
    { role: "user" as const, text: "later-msg" },
  ];
  const text = stripAnsi(renderAgentSurface(tab, { chat } as never, 80, 20).join("\n"));
  const laterAt = text.indexOf("later-msg");
  const aboveAt = text.indexOf("above");
  const steerAt = text.indexOf("Steer");
  assert.ok(laterAt >= 0 && aboveAt > laterAt);
  assert.ok(steerAt > aboveAt);
});

// --- Inline tail row budget -------------------------------------------------

function widgets(...entries: MixCodeTabInfo["extensionUi"]["widgets"]) {
  return {
    extensionUi: {
      statuses: [],
      widgets: entries,
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  };
}

function tallLines(key: string, rows: number): string[] {
  return Array.from({ length: rows }, (_, index) => `${key}-${index}`);
}

function above(key: string, rows: number) {
  return { key, placement: "aboveEditor" as const, lines: tallLines(key, rows) };
}

/** Inline widget rows for one viewport, without theme escape codes. */
function inlineTailLines(tab: MixCodeTabInfo, viewportRows: number, width = 80): string[] {
  const text = stripAnsi(renderInlineExtensionWidgets(tab, width, { viewportRows }).join("\n"));
  return text === "" ? [] : text.split("\n");
}

/** The widget named after each collapsed header in render order. */
function collapsedKeys(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const match = /\/widgets expand (\S+)/.exec(line);
    return match ? [match[1]!] : [];
  });
}

test("an over-budget inline tail collapses widgets instead of starving the chat", () => {
  const tab = widgetTab(
    widgets(above("w1", 20), above("w2", 20), above("w3", 20), above("w4", 20)),
  );
  const lines = inlineTailLines(tab, 13);
  const text = lines.join("\n");

  // 13-row viewport: budget is floor(13 * 0.7) = 9 rows. No complete body fits
  // in 9 rows, so every widget collapses whole; a shown body is never partial.
  assert.ok(lines.length <= 9, `tail rows ${lines.length} exceed the viewport budget`);
  assert.equal(lines.filter((line) => line.includes("more in widget panel")).length, 0);
  assert.deepEqual(collapsedKeys(lines), ["w1", "w2", "w3", "w4"]);
  for (const line of lines) {
    if (line.includes("/widgets expand")) assert.match(line, /\(auto\)/);
  }
  assert.doesNotMatch(text, /w1-0|w2-0|w3-0|w4-0/);

  // Leaving inline mode or supplying no viewport restores the uncollapsed dock
  // rendering the same widgets would get.
  assert.equal(renderExtensionWidgets(tab, 80, "aboveEditor").length, 80);
});

test("the most recently updated inline widget keeps its body under budget", () => {
  const tab = widgetTab(widgets());
  for (const key of ["first", "second", "third"]) {
    setExtensionWidget(tab, key, tallLines(key, 4), "aboveEditor", () => undefined);
  }

  const lines = inlineTailLines(tab, 13);
  const text = lines.join("\n");
  assert.match(text, /third-0/);
  assert.doesNotMatch(text, /first-0|second-0/);
  assert.deepEqual(collapsedKeys(lines), ["first", "second"]);
});

test("a manually expanded widget is never auto-collapsed", () => {
  const tab = widgetTab(widgets(above("pinned", 2), above("fresh", 20), above("freshest", 20)));
  tab.inlineWidgetCollapsed.set("pinned", false);

  // 9-row viewport: budget is floor(9 * 0.7) = 6 rows. The pin keeps both of
  // its body rows; the remaining widgets collapse to give it the room.
  const lines = inlineTailLines(tab, 9);
  const text = lines.join("\n");
  assert.ok(lines.length <= 6, `tail rows ${lines.length} exceed the viewport budget`);
  assert.match(text, /pinned-0[\s\S]*pinned-1/);
  assert.doesNotMatch(text, /fresh-0|freshest-0/);
  assert.deepEqual(collapsedKeys(lines), ["fresh", "freshest"]);
  assert.equal(
    lines.filter((line) => line.includes("/widgets expand pinned")).length,
    0,
    "a pinned widget never shows the auto-collapse hint",
  );
});

test("inline collapse decisions survive one-row height jitter", () => {
  const tab = widgetTab(widgets());
  setExtensionWidget(tab, "older", tallLines("older", 4), "aboveEditor", () => undefined);
  setExtensionWidget(tab, "newer", tallLines("newer", 4), "aboveEditor", () => undefined);

  assert.match(inlineTailLines(tab, 13).join("\n"), /newer-0/);
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 13)), ["older"]);

  // One row taller: the natural block grows from 11 to 12 rows. Re-expanding
  // needs slack, so the same widget stays collapsed instead of flickering.
  tab.extensionUi.widgets[1]!.lines = tallLines("newer", 5);
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 13)), ["older"]);

  // Shrinking both widgets frees the slack that re-expands the block.
  tab.extensionUi.widgets[0]!.lines = tallLines("older", 2);
  tab.extensionUi.widgets[1]!.lines = tallLines("newer", 2);
  const expanded = inlineTailLines(tab, 13);
  assert.deepEqual(collapsedKeys(expanded), []);
  assert.match(expanded.join("\n"), /older-0[\s\S]*newer-0/);
});

test("refreshing a widget recomputes the automatic decisions", () => {
  const tab = widgetTab(widgets());
  for (const key of ["first", "second", "third"]) {
    setExtensionWidget(tab, key, tallLines(key, 4), "aboveEditor", () => undefined);
  }
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 13)), ["first", "second"]);

  // Re-setting a widget is a deliberate change, not height jitter: it becomes
  // the most recently updated one and takes over the body rows.
  setExtensionWidget(tab, "first", tallLines("first", 4), "aboveEditor", () => undefined);
  const refreshed = inlineTailLines(tab, 13);
  assert.deepEqual(collapsedKeys(refreshed), ["second", "third"]);
  assert.match(refreshed.join("\n"), /first-0/);
});

test("held automatic decisions still fit the budget instead of overflowing", () => {
  const tab = widgetTab(
    widgets(
      above("goal", 8),
      above("loop", 10),
      above("bash", 8),
      above("audit", 6),
      above("queue", 4),
    ),
  );
  inlineTailLines(tab, 40);
  assert.ok(tab.inlineWidgetAutoCollapsed.size > 0, "the first frame collapses what does not fit");

  // A one-row content change stays inside the hold deadband, so this frame
  // keeps the held goal body whole instead of recomputing the decisions.
  tab.extensionUi.widgets[0]!.lines = tallLines("goal", 9);
  const held = inlineTailLines(tab, 40);
  assert.ok(held.length <= 16, `held decisions overflowed the budget: ${held.length} rows`);
  assert.match(held.join("\n"), /goal-0/);
  assert.match(held.join("\n"), /goal-8/, "the held body stays complete");
});

test("short widget bodies keep their rows and recover once the block fits", () => {
  const tab = widgetTab(widgets(above("w0", 2), above("w1", 2), above("w2", 2)));
  // Viewport 12 → budget floor(12 * 0.7) = 8: a two-row body fits next to the
  // three headers.
  const first = inlineTailLines(tab, 12);
  assert.ok(first.length <= 8, `tail rows ${first.length} exceed the budget`);
  assert.match(first.join("\n"), /w0-0[\s\S]*w0-1/);
  assert.deepEqual(collapsedKeys(first), ["w1", "w2"]);

  // Every widget shrinks to a single row, so nothing has to stay collapsed.
  for (const widget of tab.extensionUi.widgets) widget.lines = [`${widget.key}-only`];
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 12)), []);
});

test("a tiny chat viewport still leaves rows for the transcript", () => {
  const tab = widgetTab(widgets(above("w1", 20), above("w2", 20), above("w3", 20)));
  const lines = renderAgentSurface(
    tab,
    { chat: [{ role: "user", text: "tiny-chat" }] } as never,
    80,
    8,
  );
  assert.match(stripAnsi(lines.join("\n")), /tiny-chat/);
  const firstInline = lines.findIndex((line) => line.includes("▸ Inline"));
  assert.ok(firstInline >= 4, `widget block starts at row ${firstInline} of 8`);
});

test("the summary row keeps its command on narrow columns and the block caps at 24 rows", () => {
  const summary = widgetTab(
    widgets(
      ...Array.from({ length: 8 }, (_, index) => ({
        key: `w${index}`,
        placement: "aboveEditor" as const,
        lines: [`w${index}-body`],
      })),
    ),
  );
  for (const width of [24, 32, 40]) {
    const lines = renderInlineExtensionWidgets(summary, width, { viewportRows: 8 });
    assert.equal(lines.length, 1);
    assert.match(stripAnsi(lines[0]!), /\/widgets/, `width ${width} lost the expand command`);
    assert.ok(visibleWidth(lines[0]!) <= width, `width ${width} overflowed`);
  }

  // Even a very tall terminal stops the block at the 24-row ceiling.
  const tall = widgetTab(widgets(above("w0", 40), above("w1", 40)));
  assert.ok(inlineTailLines(tall, 500).length <= 24);
});

test("a render at another width does not disturb the live inline decisions", () => {
  // The padded lines wrap into more rows at 40 columns than at 80, so the two
  // widths allocate the budget differently.
  const line = (key: string, rows: number, pad: number) => ({
    key,
    placement: "aboveEditor" as const,
    lines: Array.from({ length: rows }, (_, index) =>
      pad ? `${key}-${index} ${"x".repeat(pad)}` : `${key}-${index}`,
    ),
  });
  const tab = widgetTab(widgets(line("k0", 1, 70), line("k1", 12, 30), line("k2", 9, 0)));
  const live = renderInlineExtensionWidgets(tab, 80, { viewportRows: 12 });
  assert.ok(live.length > 0);

  // A dump-screen pass over the live tab renders it at its own width; the
  // on-screen frame must not inherit what that pass decided.
  renderInlineExtensionWidgets(tab, 40, { viewportRows: 12 });
  assert.deepEqual(renderInlineExtensionWidgets(tab, 80, { viewportRows: 12 }), live);
});

test("/widgets expands an automatically collapsed tail", async () => {
  const state = createInitialState("/repo");
  const tab = widgetTab(widgets(above("w0", 20), above("w1", 20), above("w2", 20)));
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  assert.ok(collapsedKeys(inlineTailLines(tab, 24)).length > 0);
  await handleSubmittedInput(state, runtime, "/widgets", tui);
  assert.equal(collapsedKeys(inlineTailLines(tab, 24)).length, 0);
});

test("a second bare /widgets hands the widgets back to the row budget", async () => {
  const state = createInitialState("/repo");
  const tab = widgetTab(widgets(above("w0", 20), above("w1", 20), above("w2", 20)));
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  // First press: the budget has folded the tail, so every widget gets a
  // manual expand pin.
  assert.ok(collapsedKeys(inlineTailLines(tab, 24)).length > 0);
  await handleSubmittedInput(state, runtime, "/widgets", tui);
  assert.equal(tab.inlineWidgetCollapsed.size, 3);
  assert.equal(collapsedKeys(inlineTailLines(tab, 24)).length, 0);

  // Second press: the pins are released instead of becoming manual collapses,
  // so the budget re-owns every key and folds the over-budget tail again.
  await handleSubmittedInput(state, runtime, "/widgets", tui);
  assert.equal(tab.inlineWidgetCollapsed.size, 0);
  const folded = inlineTailLines(tab, 24);
  assert.deepEqual(collapsedKeys(folded), ["w0", "w1", "w2"]);
  for (const line of folded) {
    if (line.includes("/widgets expand")) assert.match(line, /\(auto\)/);
  }
});

test("a block that shrinks gradually expands once it fits", () => {
  const tab = widgetTab(widgets(above("a", 20), above("b", 1), above("c", 1)));
  inlineTailLines(tab, 24);
  assert.ok(collapsedKeys(inlineTailLines(tab, 24)).length > 0, "the tall widget folds the rest");

  // One row per frame stays inside the hold deadband, so recovery cannot rely on
  // a single large jump.
  for (let rows = 19; rows >= 1; rows--) {
    tab.extensionUi.widgets[0]!.lines = tallLines("a", rows);
    inlineTailLines(tab, 24);
  }
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 24)), []);
});

test("a widget registered while rendering is not visited in the same frame", () => {
  const rendered: string[] = [];
  const tab = widgetTab(
    widgets({
      key: "first",
      placement: "aboveEditor",
      lines: [],
      render: () => {
        rendered.push("first");
        tab.extensionUi.widgets.push({
          ...above("late", 1),
          render: () => {
            rendered.push("late");
            return ["late-0"];
          },
        });
        return ["first-0"];
      },
    }),
  );

  renderInlineExtensionWidgets(tab, 80, { viewportRows: 24 });
  assert.deepEqual(rendered, ["first"], "the late widget renders on the next frame only");

  renderInlineExtensionWidgets(tab, 80, { viewportRows: 24 });
  assert.deepEqual(rendered, ["first", "first", "late"]);
});

test("a shrink inside the hold deadband keeps the collapsed set for one frame", () => {
  const tab = widgetTab(widgets(above("w0", 3), above("w1", 4)));
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 13)), ["w1"]);

  // Natural rows drop 10 -> 8. Two rows exceed the 20% share (floor(9 * 0.2) = 1)
  // and only the constant floor (2) absorbs them, so this frame keeps the held
  // decisions; the next frame expands because the block has fit twice.
  tab.extensionUi.widgets[1]!.lines = tallLines("w1", 2);
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 13)), ["w1"]);
  assert.deepEqual(collapsedKeys(inlineTailLines(tab, 13)), []);
});

test("a widget list far larger than the budget still renders one summary row", () => {
  const tab = widgetTab(
    widgets(
      ...Array.from({ length: 400 }, (_, index) => ({
        key: `w${index}`,
        placement: "aboveEditor" as const,
        lines: tallLines(`w${index}`, 20),
      })),
    ),
  );
  const lines = inlineTailLines(tab, 40);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /400 widgets/);
});

test("a held frame keeps a pinned widget whole even when it overflows the budget", () => {
  const tab = widgetTab(widgets(above("short", 2), above("tall", 20), above("other", 20)));
  // Establish automatic decisions first, then pin the tall widget: the next
  // frame holds those decisions, and the pin keeps its complete body even
  // though the block now overflows the budget.
  inlineTailLines(tab, 36);
  tab.inlineWidgetCollapsed.set("tall", false);

  const held = inlineTailLines(tab, 36);
  const text = held.join("\n");
  assert.ok(held.length > 14, `the pinned body must stay whole, got ${held.length} rows`);
  assert.match(text, /tall-0[\s\S]*tall-19/, "the pinned body renders completely");
  assert.deepEqual(collapsedKeys(held), ["short", "other"]);
});

test("/widgets ignores automatic collapses while the tail is not rendered", async () => {
  const state = createInitialState("/repo");
  const tab = widgetTab(widgets(above("w0", 20), above("w1", 20)));
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  inlineTailLines(tab, 24);
  assert.ok(tab.inlineWidgetAutoCollapsed.size > 0);

  // With the panel open the components render their full bodies, so the frozen
  // automatic set must not turn `/widgets` into an expand-all.
  tab.panelOpen = true;
  await handleSubmittedInput(state, runtime, "/widgets", tui);
  assert.equal(tab.inlineWidgetCollapsed.get("w0"), true);
  assert.equal(tab.inlineWidgetCollapsed.get("w1"), true);
});

test("an inline block that cannot fit even headers degrades to one summary row", () => {
  const tab = widgetTab(
    widgets(
      ...Array.from({ length: 7 }, (_, index) => ({
        key: `w${index}`,
        placement: "aboveEditor" as const,
        lines: [`w${index}-body`],
      })),
    ),
  );
  const lines = inlineTailLines(tab, 8);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /7 widgets/);
  assert.match(lines[0]!, /\/widgets expand/);
});

test("auto-collapsed inline headers stay inside a narrow column", () => {
  const width = 24;
  const tab = widgetTab(
    widgets(
      above("widget-with-a-very-long-key", 20),
      above("second-widget", 20),
      above("third-widget", 20),
    ),
  );
  const lines = renderInlineExtensionWidgets(tab, width, { viewportRows: 24 });
  assert.ok(lines.length > 0);
  for (const [index, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= width,
      `line ${index} exceeds ${width}: ${JSON.stringify(stripAnsi(line))}`,
    );
  }

  const summary = renderInlineExtensionWidgets(
    widgetTab(
      widgets(
        ...Array.from({ length: 7 }, (_, index) => ({
          key: `wide-${index}`,
          placement: "aboveEditor" as const,
          lines: [`wide-${index}-body`],
        })),
      ),
    ),
    width,
    { viewportRows: 8 },
  );
  assert.equal(summary.length, 1);
  assert.ok(visibleWidth(summary[0]!) <= width);
});

test("a narrow auto-collapsed header keeps the expand hint and drops the marker", () => {
  const tab = widgetTab(widgets(above("goal", 24), above("loop", 24), above("bash", 24)));
  const headersAt = (width: number) =>
    renderInlineExtensionWidgets(tab, width, { viewportRows: 24 })
      .map((line) => stripAnsi(line))
      .filter((line) => line.includes("▸ Inline"));

  // No complete body fits the 9-row budget, so all three headers are collapsed.
  // 40 columns: the key survives, the marker does not.
  const wide = headersAt(40);
  assert.equal(wide.filter((line) => line.includes("/widgets expand")).length, 3);
  for (const line of wide) assert.doesNotMatch(line, /\(auto\)/);
  // 32 columns: only the bare command fits.
  assert.equal(headersAt(32).filter((line) => line.includes("/widgets expand")).length, 3);
  // 24 columns: the hint shortens to `/widgets`.
  assert.equal(headersAt(24).filter((line) => line.includes("/widgets")).length, 3);

  for (const width of [24, 32, 40]) {
    for (const line of renderInlineExtensionWidgets(tab, width, { viewportRows: 24 })) {
      assert.ok(visibleWidth(line) <= width);
    }
  }
});

test("a larger viewport re-expands widgets it can now fit", () => {
  const tab = widgetTab(widgets(above("w0", 6), above("w1", 6), above("w2", 6)));
  const small = inlineTailLines(tab, 12);
  assert.ok(small.length <= 6, `small tail ${small.length} rows`);
  assert.deepEqual(collapsedKeys(small), ["w0", "w1", "w2"]);

  const large = inlineTailLines(tab, 60);
  assert.deepEqual(collapsedKeys(large), []);
  assert.match(large.join("\n"), /w0-0[\s\S]*w2-0/);
});

test("a body taller than the whole budget collapses whole, never partially", () => {
  const tab = widgetTab(widgets(above("huge", 30), above("small", 2)));
  // The small widget is the most recently updated, so it takes the rows first;
  // the huge body cannot fit whole after it, so it collapses instead of showing
  // a cut.
  setExtensionWidget(tab, "small", tallLines("small", 2), "aboveEditor", () => undefined);
  const lines = inlineTailLines(tab, 24);

  assert.deepEqual(collapsedKeys(lines), ["huge"]);
  assert.match(lines.join("\n"), /small-0[\s\S]*small-1/);
  assert.doesNotMatch(lines.join("\n"), /huge-0/);
  assert.equal(lines.filter((line) => line.includes("more in widget panel")).length, 0);
});

test("the cut stops at the first widget whose whole body does not fit", () => {
  const tab = widgetTab(widgets(above("w0", 4), above("w1", 2), above("w2", 2)));
  const lines = inlineTailLines(tab, 13);

  // Budget 9: w0 whole (4) fits; w1 whole would need one row too many, so w1 and
  // the later, smaller w2 both collapse instead of jumping ahead of the cut.
  assert.deepEqual(collapsedKeys(lines), ["w1", "w2"]);
  assert.match(lines.join("\n"), /w0-0[\s\S]*w0-3/);
  assert.doesNotMatch(lines.join("\n"), /w1-0|w2-0/);
});

test("an expanded body longer than 20 lines renders completely with no hint", () => {
  const tab = widgetTab(widgets(above("long", 22)));
  const lines = inlineTailLines(tab, 60);

  // Single-widget budget floor(60 * 0.7) = 42 rows, capped at the 24-row
  // ceiling, fits the whole 22-line body.
  assert.deepEqual(collapsedKeys(lines), []);
  assert.match(lines.join("\n"), /long-21/, "the full body renders");
  assert.equal(lines.filter((line) => line.includes("more in widget panel")).length, 0);
});

test("the inline budget renders each widget once per frame", () => {
  const calls = new Map<string, number>();
  const counted = (key: string) => ({
    key,
    placement: "aboveEditor" as const,
    lines: [],
    render: () => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return tallLines(key, 20);
    },
  });
  const tab = widgetTab(widgets(counted("w1"), counted("w2"), counted("w3")));

  renderInlineExtensionWidgets(tab, 80, { viewportRows: 24 });
  renderInlineExtensionWidgets(tab, 80, { viewportRows: 24 });
  assert.deepEqual(
    [...calls.entries()],
    [
      ["w1", 2],
      ["w2", 2],
      ["w3", 2],
    ],
  );
});

test("an over-budget inline tail leaves room for the chat transcript", () => {
  const tab = widgetTab(
    widgets(above("w1", 20), above("w2", 20), above("w3", 20), above("w4", 20)),
  );
  const chat = Array.from({ length: 8 }, (_, index) => ({
    role: "user" as const,
    text: `chat-${index}`,
  }));

  const lines = renderAgentSurface(tab, { chat } as never, 80, 24);
  assert.ok(lines.length <= 24, `surface rows ${lines.length} exceed the viewport`);
  const text = stripAnsi(lines.join("\n"));
  const inlineRows = lines.length - lines.findIndex((line) => line.includes("▸ Inline · w1"));
  assert.ok(inlineRows <= 9, `widget block rows ${inlineRows} exceed the 9-row budget`);
  assert.match(text, /chat-7/, "the newest chat message stays on screen");
  assert.match(text, /chat-6/, "the widget block does not swallow the transcript");
  assert.match(text, /widgets expand w4/, "the collapsed widgets stay discoverable");
});

test("/widgets expand clears the automatic collapse for that widget", async () => {
  const state = createInitialState("/repo");
  const tab = widgetTab(widgets(above("w1", 20), above("w2", 20), above("w3", 20)));
  state.tabs.push(tab);
  state.activeTabId = tab.sessionId;
  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  inlineTailLines(tab, 24);
  assert.ok(tab.inlineWidgetAutoCollapsed.size > 0);

  await handleSubmittedInput(state, runtime, "/widgets expand w3", tui);
  assert.equal(tab.inlineWidgetCollapsed.get("w3"), false);
  assert.equal(tab.inlineWidgetAutoCollapsed.has("w3"), false);
  const lines = inlineTailLines(tab, 24);
  assert.match(lines.join("\n"), /w3-0/);
  assert.ok(!collapsedKeys(lines).includes("w3"));
});
