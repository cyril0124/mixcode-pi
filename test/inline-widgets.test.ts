import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditorComponent, TUI as TuiType } from "@earendil-works/pi-tui";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { parseInput, commandSuggestions } from "../src/core/commands.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { serializeState } from "../src/core/state-store.js";
import { activateTab, addAgentTab } from "../src/core/tabs.js";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "../src/ui/app-editor.js";
import {
  MixCodeFooterRoot,
  MixCodeLayoutRoot,
  MixCodeRoot,
  TERMINAL_SCROLL_GUARD_ROWS,
} from "../src/ui/app-layout.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { OverlayTui } from "../src/ui/app-types.js";
import { buildLabeledTopBorder } from "../src/ui/editor-top-border.js";
import {
  renderAgentSurface,
  renderExtensionFooter,
  renderExtensionWidgets,
  renderFooter,
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
  inlineWidgets?: boolean;
}): string {
  return stripAnsi(
    buildLabeledTopBorder({
      width: opts.width,
      title: opts.title,
      vimMode: opts.vimMode === true,
      zenMode: opts.zenMode === true,
      inlineWidgets: opts.inlineWidgets === true,
      dash: identity,
      vimLabel: identity,
      zenLabel: identity,
      inlLabel: identity,
      titleLabel: identity,
    }),
  );
}

function widgetTab(
  overrides: Parameters<typeof createTab>[3] = {},
): ReturnType<typeof createTab> {
  return createTab(1, "s1", "/repo", {
    inlineWidgets: true,
    extensionUi: {
      statuses: [],
      widgets: [
        { id: "above", placement: "aboveEditor", lines: ["INLINE-ABOVE"] },
        { id: "below", placement: "belowEditor", lines: ["INLINE-BELOW"] },
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
    () =>
      editorRows +
      metaRows +
      renderExtensionFooter(tab, width).length +
      renderFooter(width).length +
      TERMINAL_SCROLL_GUARD_ROWS,
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
  assert.ok(commandSuggestions("/toggle-inline").includes("toggle-inline-widgets"));
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

test("activateTab transfers inlineWidgets to the destination agent", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { inlineWidgets: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  activateTab(state, "s2");
  assert.equal(first.inlineWidgets, false);
  assert.equal(second.inlineWidgets, true);
});

test("activateTab to Home keeps inlineWidgets on the agent", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { inlineWidgets: true });
  state.tabs.push(first);
  state.activeTabId = "s1";
  activateTab(state, "home");
  assert.equal(first.inlineWidgets, true);
});

test("new tabs inherit ui.inlineWidgets from mixcode settings", () => {
  const state = createInitialState("/repo");
  state.ui = { ...state.ui!, inlineWidgets: true };
  const tab = addAgentTab(state, "s1", "/repo");
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
  assert.match(stripAnsi(inline), /INLINE-ABOVE/);
});

test("inline widgets sit after messages and before the queue preview", () => {
  const tab = widgetTab({ pendingMessages: ["steer-me"] });
  const text = stripAnsi(
    renderAgentSurface(
      tab,
      { chat: [{ role: "user", text: "hello-user" }] } as never,
      80,
    ).join("\n"),
  );
  const userAt = text.indexOf("hello-user");
  const aboveAt = text.indexOf("INLINE-ABOVE");
  const belowAt = text.indexOf("INLINE-BELOW");
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
  assert.ok(text.indexOf("second-msg") < text.indexOf("INLINE-ABOVE"));
  assert.ok(text.indexOf("INLINE-BELOW") < text.indexOf("Steer"));
});

test("scrolling up moves the queue then inline widgets off the bottom", () => {
  const chat = Array.from({ length: 20 }, (_, i) => ({
    role: "user" as const,
    text: `msg-${String(i).padStart(2, "0")}`,
  }));
  const tab = widgetTab({ pendingMessages: ["steer-me"] });
  const bottom = stripAnsi(renderAgentSurface(tab, { chat } as never, 80, 8).join("\n"));
  assert.match(bottom, /INLINE-ABOVE/);
  assert.match(bottom, /INLINE-BELOW/);
  assert.match(bottom, /Steer/);

  tab.chatScrollOffset = 1_000_000;
  const top = stripAnsi(renderAgentSurface(tab, { chat } as never, 80, 8).join("\n"));
  assert.match(top, /msg-00/);
  assert.doesNotMatch(top, /INLINE-ABOVE|INLINE-BELOW|Steer/);
});

test("windowed inline widgets stay between messages and the queue", () => {
  const chat = Array.from({ length: 60 }, (_, i) => ({
    role: "user" as const,
    text: `long-${String(i).padStart(2, "0")}`,
  }));
  const tab = widgetTab({ pendingMessages: ["steer-me"] });
  const text = stripAnsi(renderAgentSurface(tab, { chat } as never, 80, 12).join("\n"));
  const last = text.indexOf("long-59");
  const aboveAt = text.indexOf("INLINE-ABOVE");
  const belowAt = text.indexOf("INLINE-BELOW");
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
    const start = text.indexOf("INLINE-BELOW");
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
  assert.match(text, /INLINE-ABOVE/);
  assert.match(text, /INLINE-BELOW/);
  assert.match(text, /Steer/);
  assert.ok(text.indexOf("INLINE-BELOW") < text.indexOf("Steer"));
});

test("an open side panel keeps widgets out of the chat tail", () => {
  const tab = widgetTab({ panelOpen: true, pendingMessages: ["steer-me"] });
  const text = stripAnsi(
    renderAgentSurface(tab, { chat: [{ role: "user", text: "hello-user" }] } as never, 80).join(
      "\n",
    ),
  );
  assert.doesNotMatch(text, /INLINE-ABOVE|INLINE-BELOW/);
  assert.match(text, /Steer/);
});

test("inline mode removes docked widgets and grows the chat surface", () => {
  const { layout, tab } = buildLayout(24);
  tab.extensionUi.widgets = [
    { id: "above", placement: "aboveEditor", lines: ["INLINE-ABOVE"] },
    { id: "below", placement: "belowEditor", lines: ["INLINE-BELOW"] },
  ];

  layout.render(80);
  const docked = layout.render(80);
  const dockedChat = tab.chatSurfaceBounds?.height ?? 0;
  assert.match(stripAnsi(docked.join("\n")), /INLINE-ABOVE/);

  tab.inlineWidgets = true;
  layout.render(80);
  const inlined = layout.render(80);
  const inlinedText = stripAnsi(inlined.join("\n"));
  const inlinedChat = tab.chatSurfaceBounds?.height ?? 0;
  assert.match(inlinedText, /INLINE-ABOVE/);
  assert.match(inlinedText, /editor-line-0/);
  assert.equal(inlinedText.split("INLINE-ABOVE").length - 1, 1, "widgets must not render twice");
  assert.ok(inlinedChat > dockedChat, `chat should grow: ${inlinedChat} vs ${dockedChat}`);
});

test("inline widgets stay in the chat column, not the editor dock", () => {
  const { layout, main, tab } = buildLayout(24);
  tab.extensionUi.widgets = [
    { id: "above", placement: "aboveEditor", lines: ["INLINE-ABOVE"] },
  ];

  const dockedMain = stripAnsi(main.render(80).join("\n"));
  assert.doesNotMatch(dockedMain, /INLINE-ABOVE/);

  tab.inlineWidgets = true;
  const inlinedMain = stripAnsi(main.render(80).join("\n"));
  assert.match(inlinedMain, /INLINE-ABOVE/);

  layout.render(80);
  const full = stripAnsi(layout.render(80).join("\n"));
  assert.equal(full.split("INLINE-ABOVE").length - 1, 1);
});

test("inline mode embeds [INL] on the default editor top border", () => {
  const line = border({ width: 40, title: "Agent-1", inlineWidgets: true });
  assert.match(line, /^── \[INL\] /);
  assert.match(line, /Agent-1/);
});

test("VIM ZEN INL badges share the left slot in that order", () => {
  const line = border({
    width: 56,
    title: "Agent-1",
    vimMode: true,
    zenMode: true,
    inlineWidgets: true,
  });
  assert.match(line, /^── \[VIM\] \[ZEN\] \[INL\] /);
});

test("narrow borders drop [INL] before [ZEN] and [VIM]", () => {
  const line = border({
    width: 18,
    title: "Agent-1",
    vimMode: true,
    zenMode: true,
    inlineWidgets: true,
  });
  assert.doesNotMatch(line, /\[INL\]/);
  assert.match(line, /\[VIM\]|\[ZEN\]|Agent-1/);
});

test("default editor chrome shows [INL] when inline widgets are on", () => {
  const { slot } = makeSlot();
  const plain = stripAnsi(slot.render(64).join("\n"));
  assert.match(plain, /\[INL\]/);
  assert.match(plain, /Agent-01/);
});

test("setEditorComponent body stays unlabeled; [INL] moves to the separator", () => {
  const { slot } = makeSlot();
  const width = 56;
  const plainTop = "─".repeat(width);
  slot.setEditorComponent(() => stubEditor([plainTop, " plugin-body ", plainTop]));
  const body = stripAnsi(slot.render(width).join("\n"));
  assert.match(body, /plugin-body/);
  assert.doesNotMatch(body, /\[INL\]|Agent-01/);

  const separator = stripAnsi(
    renderTabBarSeparator(width, {
      inlineWidgets: true,
      agentChrome: { title: "Agent-01" },
    }).join("\n"),
  );
  assert.match(separator, /\[INL\]/);
  assert.match(separator, /Agent-01/);
});

test("temporary input override does not receive [INL]", () => {
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
  assert.doesNotMatch(plain, /\[INL\]|Agent-01/);

  const separator = stripAnsi(renderTabBarSeparator(40, { inlineWidgets: true }).join("\n"));
  assert.doesNotMatch(separator, /\[INL\]/);
});

test("custom()/dialog takeover hides [INL] on the separator until restore", () => {
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
  const main = new MixCodeRoot(state, runtime, () => 24, () => 4, () => true);

  const during = stripAnsi(main.render(80).join("\n"));
  assert.match(during, /Agent-01/);
  assert.doesNotMatch(during, /\[INL\]/);

  tab.extensionUi.waitingForInputs = [];
  const restored = stripAnsi(main.render(80).join("\n"));
  assert.match(restored, /\[INL\]/);
  assert.match(restored, /Agent-01/);
});

test("setInputComponent takeover hides [INL] on a permanent-skin separator", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Agent-01", inlineWidgets: true });
  state.tabs = [tab];
  state.activeTabId = "s1";
  const runtime = new MixCodeRuntime();
  let inputOpen = true;
  const main = new MixCodeRoot(
    state,
    runtime,
    () => 24,
    () => 4,
    () => true,
    () => inputOpen,
  );

  const during = stripAnsi(main.render(80).join("\n"));
  assert.match(during, /Agent-01/);
  assert.doesNotMatch(during, /\[INL\]/);

  inputOpen = false;
  const restored = stripAnsi(main.render(80).join("\n"));
  assert.match(restored, /\[INL\]/);
});

test("turning inline widgets off restores the dock and drops [INL]", () => {
  const { layout, main, tab } = buildLayout(24);
  tab.extensionUi.widgets = [{ id: "above", placement: "aboveEditor", lines: ["INLINE-ABOVE"] }];
  tab.inlineWidgets = true;
  layout.render(80);
  assert.match(stripAnsi(main.render(80).join("\n")), /INLINE-ABOVE/);

  tab.inlineWidgets = false;
  layout.render(80);
  assert.doesNotMatch(stripAnsi(main.render(80).join("\n")), /INLINE-ABOVE/);
  assert.match(stripAnsi(layout.render(80).join("\n")), /INLINE-ABOVE/);
  assert.doesNotMatch(border({ width: 40, title: "Agent-1" }), /\[INL\]/);
});

test("zen + custom editor keeps status dots and [INL] on one separator", () => {
  const line = stripAnsi(
    renderTabBarSeparator(64, {
      zenMode: true,
      zenStatusMarkers: ["working", "done"],
      inlineWidgets: true,
      agentChrome: { title: "Agent-17" },
    }).join("\n"),
  );
  assert.match(line, /●/);
  assert.match(line, /\[INL\]/);
  assert.match(line, /Agent-17/);
});

test("side panel leaves [INL] on the default editor", () => {
  const { slot, tab } = makeSlot();
  tab.panelOpen = true;
  const plain = stripAnsi(slot.render(64).join("\n"));
  assert.match(plain, /\[INL\]/);
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
  const aboveAt = text.indexOf("INLINE-ABOVE");
  const steerAt = text.indexOf("Steer");
  assert.ok(laterAt >= 0 && aboveAt > laterAt);
  assert.ok(steerAt > aboveAt);
});
