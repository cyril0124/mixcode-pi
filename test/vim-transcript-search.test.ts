import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { ChatLine, MixCodeRuntime, RuntimeTab } from "../src/agent/runtime.js";
import { testTui } from "./helpers/tui.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { activateTab, discardVimTranscriptSearch } from "../src/core/tabs.js";
import { CompactPromptEditor, EditorSlot } from "../src/ui/app-editor.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { MixCodeLayoutRoot } from "../src/ui/app-layout.js";
import type { MixCodeEditorActions } from "../src/ui/app-types.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { highlightVisibleColumnRanges } from "../src/ui/rendering/highlight.js";
import {
  findTranscriptSearchMatches,
  transcriptSearchMatchKey,
} from "../src/ui/vim-transcript-search.js";

function createSearchEditorHarness(
  state: ReturnType<typeof createInitialState>,
  runtime?: MixCodeRuntime,
) {
  let overlayCalls = 0;
  const tui = {
    terminal: { columns: 80, rows: 24 },
    requestRender: () => undefined,
    setFocus: () => undefined,
    showOverlay: () => {
      overlayCalls++;
      return {
        hide: () => undefined,
        focus: () => undefined,
        unfocus: () => undefined,
        isFocused: () => true,
      };
    },
    hasOverlay: () => false,
  } as unknown as TuiType;
  const promptEditor = new CompactPromptEditor(tui, {} as never, undefined, state);
  const slot = new EditorSlot(tui, promptEditor, state);
  slot.current;
  const actions: MixCodeEditorActions = {
    getText: () => slot.getText(),
    getExpandedText: () => slot.getExpandedText(),
    setText: (text) => slot.setText(text),
    insertTextAtCursor: (text) => slot.insertTextAtCursor(text),
    submitCurrentText: () => slot.submitCurrentText(),
    browsePromptHistory: (data) => slot.browsePromptHistory(data),
  };
  const dispatch = (data: string) => {
    const result = handleMixCodeKeyInput(
      state,
      data,
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      actions,
    );
    if (!result?.consume) slot.handleInput(data);
    return result;
  };
  return { actions, dispatch, overlayCalls: () => overlayCalls, slot, tui };
}

test("transcript search matches literal text across ANSI lines and collapsed whitespace", () => {
  const lines = ["\x1b[31mRetry\x1b[39m   scheduled", "after 5 seconds"];

  // All-lowercase query stays case-insensitive (matches "…scheduled after 5…").
  assert.deepEqual(findTranscriptSearchMatches(lines, "scheduled after 5"), [
    {
      segments: [
        { row: 0, startCol: 8, endCol: 17 },
        { row: 1, startCol: 0, endCol: 5 },
        { row: 1, startCol: 6, endCol: 7 },
      ],
    },
  ]);
});

test("transcript search smartcase: uppercase query matches case-sensitively", () => {
  const lines = ["foo Foo FOO", "café Café"];
  const count = (query: string) => findTranscriptSearchMatches(lines, query).length;

  // All-lowercase query (ASCII or non-ASCII) stays case-insensitive.
  assert.equal(count("foo"), 3);
  assert.equal(count("café"), 2);
  // Any uppercase letter (incl. non-ASCII \p{Lu}) turns the query case-sensitive.
  assert.equal(count("Foo"), 1);
  assert.equal(count("FOO"), 1);
  assert.equal(count("Café"), 1);
});

test("visible-column highlighting preserves existing ANSI styling", () => {
  const line = "\x1b[31mRetry\x1b[39m scheduled";

  const highlighted = highlightVisibleColumnRanges(
    line,
    [{ startCol: 0, endCol: 5 }],
    (text) => `\x1b[7m${text}\x1b[27m`,
  );

  assert.equal(stripTerminalSequences(highlighted), "Retry scheduled");
  assert.match(highlighted, /^\x1b\[31m\x1b\[7mRetry\x1b\[27m/);
  assert.ok(highlighted.indexOf("\x1b[39m") < highlighted.indexOf(" scheduled"));
});

test("visible-column highlighting ignores any valid ANSI CSI sequence", () => {
  const line = "\x1b[2Cneedle tail";

  const highlighted = highlightVisibleColumnRanges(
    line,
    [{ startCol: 0, endCol: 6 }],
    (text) => `\x1b[7m${text}\x1b[27m`,
  );

  assert.equal(stripTerminalSequences(highlighted.replace("\x1b[2C", "")), "needle tail");
  assert.match(highlighted, /^\x1b\[2C\x1b\[7mneedle\x1b\[27m/);
});

test("active Vim transcript search reveals and highlights an off-screen rendered match", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  tab.vimTranscriptSearch = {
    query: "hidden needle",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: 100,
    promptOpen: false,
  };
  const runtimeTab = {
    chat: [
      { role: "assistant", text: "old hidden needle" },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: "assistant" as const,
        text: `new answer ${index}`,
      })),
    ],
  } as RuntimeTab;

  const rendered = renderAgentSurface(tab, runtimeTab, 60, 6);

  assert.equal(tab.vimTranscriptSearch.resultCount, 1);
  assert.equal(tab.vimTranscriptSearch.selectedIndex, 0);
  assert.match(stripTerminalSequences(rendered.join("\n")), /old hidden needle/);
  assert.match(rendered.join("\n"), /\x1b\[7m/);
});

test("transcript search reveals a match hidden by a viewport boundary marker", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const runtimeTab = {
    chat: Array.from({ length: 12 }, (_, index) => ({
      role: "assistant" as const,
      text: index === 5 ? "boundary needle" : `answer ${index}`,
    })),
  } as RuntimeTab;
  const fullLines = renderAgentSurface(tab, runtimeTab, 60);
  const [match] = findTranscriptSearchMatches(fullLines, "boundary needle");
  assert.ok(match);
  const matchRow = match.segments[0]!.row;
  const viewport = 6;
  tab.chatScrollOffset = fullLines.length - viewport - matchRow;
  tab.vimTranscriptSearch = {
    query: "boundary needle",
    selectedIndex: 0,
    resultCount: 1,
    selectedKey: transcriptSearchMatchKey(match),
    selectionMode: "next",
    anchorRow: 0,
    promptOpen: false,
  };

  const rendered = renderAgentSurface(tab, runtimeTab, 60, viewport);

  assert.match(stripTerminalSequences(rendered.join("\n")), /boundary needle/);
});

test("first search anchors to the visible row from a windowed long transcript", () => {
  const tab = createTab(1, "s1", "/repo", {
    vimMode: true,
    chatScrollOffset: 30,
  });
  const runtimeTab = {
    chat: Array.from({ length: 100 }, (_, index) => ({
      role: "assistant" as const,
      text: `needle answer ${index}`,
    })),
  } as RuntimeTab;
  const visibleText = (line: string) => stripTerminalSequences(line).replace(/[│█]$/, "").trim();
  const before = renderAgentSurface(tab, runtimeTab, 60, 8);
  const visibleNeedle = before.map(visibleText).find((line) => line.startsWith("needle answer"));
  assert.ok(visibleNeedle);
  tab.vimTranscriptSearch = {
    query: "needle",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: tab.lastChatScrollMetrics?.start ?? 0,
    anchorPending: true,
    promptOpen: false,
  };

  const after = renderAgentSurface(tab, runtimeTab, 60, 8);

  assert.ok(after.map(visibleText).includes(visibleNeedle));
});

test("transcript search indexes rendered extension output once across query changes", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  tab.vimTranscriptSearch = {
    query: "rendered needle",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: 0,
    promptOpen: false,
  };
  let renderCalls = 0;
  // Typed as ChatLine[]: an inline literal narrows `chat` past RuntimeTab["chat"],
  // which makes the RuntimeTab assertion non-comparable.
  const chat: ChatLine[] = [
    {
      role: "extension",
      text: "semantic source text",
      renderExtension: () => {
        renderCalls++;
        return ["rendered needle"];
      },
    },
  ];
  const runtimeTab = { chat } as RuntimeTab;

  renderAgentSurface(tab, runtimeTab, 60, 6);
  assert.equal(tab.vimTranscriptSearch.resultCount, 1);
  assert.equal(renderCalls, 1);

  tab.vimTranscriptSearch.query = "semantic source text";
  tab.vimTranscriptSearch.selectionMode = "query";
  renderAgentSurface(tab, runtimeTab, 60, 6);
  assert.equal(tab.vimTranscriptSearch.resultCount, 0);
  assert.equal(renderCalls, 1);
});

test("transcript search renders but does not index the live run tail", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true, status: "running" });
  tab.vimTranscriptSearch = {
    query: "stream needle",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: 0,
    promptOpen: false,
  };
  let stableRenderCalls = 0;
  const runtimeTab = {
    currentRunChatStartIndex: 1,
    chat: [
      {
        role: "extension",
        text: "stable extension",
        renderExtension: () => {
          stableRenderCalls++;
          return ["stable rendered output"];
        },
      },
      { role: "assistant", text: "stream needle one" },
    ],
  } as RuntimeTab;

  let rendered = renderAgentSurface(tab, runtimeTab, 60, 8);
  assert.equal(tab.vimTranscriptSearch.resultCount, 0);
  assert.match(stripTerminalSequences(rendered.join("\n")), /stream needle one/);
  assert.equal(stableRenderCalls, 1);

  runtimeTab.chat[1] = { role: "assistant", text: "stream needle two\nextra line" };
  rendered = renderAgentSurface(tab, runtimeTab, 60, 8);
  assert.equal(tab.vimTranscriptSearch.resultCount, 0);
  assert.match(stripTerminalSequences(rendered.join("\n")), /stream needle two/);
  assert.equal(stableRenderCalls, 1);

  runtimeTab.currentRunChatStartIndex = undefined;
  tab.status = "idle";
  tab.vimTranscriptSearch.selectionMode = "query";
  renderAgentSurface(tab, runtimeTab, 60, 8);
  assert.equal(tab.vimTranscriptSearch.resultCount, 1);
});

test("transcript search promotes completed concurrent tools into the stable index", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  tab.vimTranscriptSearch = {
    query: "completed needle",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: 0,
    promptOpen: false,
  };
  const runtimeTab = {
    chat: [
      { role: "assistant", text: "stable answer" },
      { role: "tool", title: "first", status: "running", text: "completed needle" },
      { role: "tool", title: "second", status: "running", text: "still running" },
    ],
  } as RuntimeTab;

  renderAgentSurface(tab, runtimeTab, 60, 8);
  assert.equal(tab.vimTranscriptSearch.resultCount, 0);

  runtimeTab.chat[1] = {
    role: "tool",
    title: "first",
    status: "success",
    text: "completed needle",
  };
  tab.vimTranscriptSearch.selectionMode = "query";
  renderAgentSurface(tab, runtimeTab, 60, 8);

  assert.equal(tab.vimTranscriptSearch.resultCount, 1);
});

test("transcript search keeps a scrolled viewport stable while the live tail grows", () => {
  const tab = createTab(1, "s1", "/repo", {
    vimMode: true,
    status: "running",
    chatScrollOffset: 4,
  });
  tab.vimTranscriptSearch = {
    query: "missing query",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "retain",
    anchorRow: 0,
    promptOpen: false,
  };
  const stableChat = Array.from({ length: 10 }, (_, index) => ({
    role: "assistant" as const,
    text: `stable answer ${index}`,
  }));
  const runtimeTab = {
    currentRunChatStartIndex: stableChat.length,
    chat: [...stableChat, { role: "assistant", text: "stream line" }],
  } as RuntimeTab;
  const firstContent = (lines: string[]) =>
    lines
      .map((line) => stripTerminalSequences(line).replace(/[│█]$/, "").trim())
      .find((line) => line && !line.includes("older above") && !line.includes("newer below"));

  const before = renderAgentSurface(tab, runtimeTab, 60, 6);
  const anchor = firstContent(before);
  assert.ok(anchor);

  runtimeTab.chat[stableChat.length] = {
    role: "assistant",
    text: "stream line\nextra one\nextra two\nextra three",
  };
  const after = renderAgentSurface(tab, runtimeTab, 60, 6);

  assert.equal(firstContent(after), anchor);
});

test("transcript search respects the rendered hidden-thinking label", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  tab.extensionUi.hiddenThinkingLabel = "Reasoning hidden";
  tab.vimTranscriptSearch = {
    query: "private chain",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: 0,
    promptOpen: false,
  };
  const runtimeTab = {
    chat: [{ role: "thinking", text: "private chain" }],
  } as RuntimeTab;

  renderAgentSurface(tab, runtimeTab, 60, 6, undefined, { hideThinking: true });
  assert.equal(tab.vimTranscriptSearch.resultCount, 0);

  tab.vimTranscriptSearch.query = "reasoning hidden";
  tab.vimTranscriptSearch.selectionMode = "query";
  renderAgentSurface(tab, runtimeTab, 60, 6, undefined, { hideThinking: true });
  assert.equal(tab.vimTranscriptSearch.resultCount, 1);
});

test("only slash reuses the Vim editor row without opening an overlay", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  harness.slot.setText("saved draft");

  harness.dispatch("\x1b[102;6u");
  // Read into a local: assert.equal is `asserts actual is T`, so asserting on
  // tab.vimTranscriptSearch directly would pin it to undefined below.
  const searchAfterKitty = tab.vimTranscriptSearch;
  assert.equal(searchAfterKitty, undefined);
  assert.equal(harness.slot.getText(), "saved draft");

  const result = harness.dispatch("/");

  assert.deepEqual(result, { consume: true });
  assert.equal(tab.vimTranscriptSearch?.promptOpen, true);
  assert.equal(harness.overlayCalls(), 0);
  assert.equal(harness.slot.getText(), "");
  assert.match(stripTerminalSequences(harness.slot.render(32).join("\n")), /\/.*0\/0/);

  harness.dispatch("\x1b");
  assert.equal(tab.vimTranscriptSearch, undefined);
  assert.equal(harness.slot.getText(), "saved draft");
});

test("inline search editor shows N/M, commits, and n/N cycle matches", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtimeTab = {
    chat: [
      { role: "assistant", text: "first needle" },
      { role: "assistant", text: "second needle" },
    ],
  } as RuntimeTab;
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  const harness = createSearchEditorHarness(state, runtime);
  harness.slot.setText("saved draft");

  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);
  renderAgentSurface(tab, runtimeTab, 60, 8);

  assert.equal(tab.vimTranscriptSearch?.resultCount, 2);
  const editorLine = stripTerminalSequences(harness.slot.render(32).join("\n"));
  assert.match(editorLine, /\/needle/);
  assert.match(editorLine, /1\/2/);
  assert.ok(
    editorLine.indexOf("1/2") - editorLine.indexOf("needle") <= "needle".length + 2,
    "match count must stay next to the query instead of at the terminal edge",
  );
  assert.doesNotMatch(editorLine, /Find transcript/);

  harness.dispatch("\r");
  assert.equal(tab.vimTranscriptSearch?.promptOpen, false);
  assert.equal(harness.slot.getText(), "saved draft");
  assert.match(stripTerminalSequences(harness.slot.render(32).join("\n")), /\/needle\s+1\/2/);

  assert.deepEqual(harness.dispatch("n"), { consume: true });
  renderAgentSurface(tab, runtimeTab, 60, 8);
  assert.equal(tab.vimTranscriptSearch?.selectedIndex, 1);
  assert.match(stripTerminalSequences(harness.slot.render(32).join("\n")), /\/needle\s+2\/2/);

  harness.dispatch("N");
  renderAgentSurface(tab, runtimeTab, 60, 8);
  assert.equal(tab.vimTranscriptSearch?.selectedIndex, 0);
  assert.match(stripTerminalSequences(harness.slot.render(32).join("\n")), /\/needle\s+1\/2/);

  harness.dispatch("q");
  assert.equal(tab.vimMode, false);
  assert.equal(tab.vimTranscriptSearch, undefined);
});

test("layout shows the match count computed by the transcript in the same frame", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);
  const main = {
    invalidate: () => undefined,
    render: () => {
      tab.vimTranscriptSearch!.selectedIndex = 0;
      tab.vimTranscriptSearch!.resultCount = 12;
      return [];
    },
  };
  const footer = { invalidate: () => undefined, render: () => [] };
  const layout = new MixCodeLayoutRoot(
    state,
    main as never,
    harness.slot,
    footer as never,
    () => undefined,
    () => undefined,
    () => 24,
    harness.tui,
  );

  const rendered = stripTerminalSequences(layout.render(32).join("\n"));

  assert.match(rendered, /\/needle\s+1\/12/);
  assert.doesNotMatch(rendered, /0\/0/);
});

test("layout updates a committed search count after n in the same frame", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);
  harness.dispatch("\r");
  const main = {
    invalidate: () => undefined,
    render: () => {
      tab.vimTranscriptSearch!.selectedIndex = 1;
      tab.vimTranscriptSearch!.resultCount = 12;
      return [];
    },
  };
  const footer = { invalidate: () => undefined, render: () => [] };
  const layout = new MixCodeLayoutRoot(
    state,
    main as never,
    harness.slot,
    footer as never,
    () => undefined,
    () => undefined,
    () => 24,
    harness.tui,
  );

  const rendered = stripTerminalSequences(layout.render(32).join("\n"));

  assert.match(rendered, /\/needle\s+2\/12/);
  assert.doesNotMatch(rendered, /0\/0/);
});

test("search prompt keeps mouse scrolling and blocks history or autocomplete keys", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  harness.slot.addToHistory("older prompt");
  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);

  harness.dispatch("\x1b[A");
  harness.dispatch("\t");
  harness.dispatch("\x1b[<64;1;1M");

  assert.equal(tab.vimTranscriptSearch?.query, "needle");
  assert.equal(tab.chatScrollOffset, 3);
});

test("switching tabs during a search restores the source draft", () => {
  const source = createTab(1, "s1", "/repo", { vimMode: true });
  const destination = createTab(2, "s2", "/repo", { draftInput: "target draft" });
  const state = createInitialState("/repo");
  state.tabs.push(source, destination);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  harness.actions.setText("source draft");
  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);

  activateTab(state, "s2");
  harness.slot.render(40);

  assert.equal(source.draftInput, "source draft");
  assert.equal(source.vimTranscriptSearch, undefined);
  assert.equal(destination.vimMode, true);
  assert.equal(harness.actions.getText(), "target draft");
});

test("discarding an active search restores the live editor draft", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  harness.actions.setText("saved draft");
  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);

  discardVimTranscriptSearch(tab);
  harness.slot.render(40);

  assert.equal(harness.actions.getText(), "saved draft");
  assert.equal(tab.draftInput, "saved draft");
  assert.equal(tab.vimSearchDraftRestorePending, undefined);
});

test("discarding an active search resets prompt history navigation", () => {
  const tab = createTab(1, "s1", "/repo");
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  harness.slot.addToHistory("older prompt");
  harness.slot.addToHistory("newer prompt");
  assert.equal(harness.slot.browsePromptHistory("\x1b[A"), true);
  assert.equal(harness.slot.browsePromptHistory("\x1b[A"), true);
  assert.equal(harness.actions.getText(), "older prompt");
  harness.slot.current.setText("saved draft");
  tab.draftInput = "saved draft";
  tab.vimMode = true;
  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);

  discardVimTranscriptSearch(tab);
  harness.slot.render(40);
  tab.vimMode = false;

  assert.equal(harness.slot.browsePromptHistory("\x1b[B"), false);
  assert.equal(harness.actions.getText(), "saved draft");
});

test("search temporarily uses the standard editor row over a custom editor skin", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const harness = createSearchEditorHarness(state);
  let customText = "";
  const customEditor = {
    render: () => [`custom:${customText}`],
    invalidate: () => undefined,
    handleInput: (data: string) => {
      if (data.length === 1 && data.charCodeAt(0) >= 32) customText += data;
    },
    getText: () => customText,
    getExpandedText: () => customText,
    setText: (text: string) => {
      customText = text;
    },
  };
  harness.slot.setEditorComponent((() => customEditor) as never, "s1");
  harness.actions.setText("custom draft");
  harness.dispatch("/");
  for (const char of "needle") harness.dispatch(char);
  tab.vimTranscriptSearch!.selectedIndex = 0;
  tab.vimTranscriptSearch!.resultCount = 8;

  const searchLines = stripTerminalSequences(harness.slot.render(40).join("\n"));
  assert.match(searchLines, /needle\s+1\/8/);
  assert.doesNotMatch(searchLines, /custom:/);

  harness.dispatch("\r");
  assert.match(stripTerminalSequences(harness.slot.render(40).join("\n")), /\/needle\s+1\/8/);

  harness.dispatch("q");
  assert.match(stripTerminalSequences(harness.slot.render(40).join("\n")), /custom:custom draft/);

  state.activeTabId = "missing";
  assert.doesNotMatch(stripTerminalSequences(harness.slot.render(40).join("\n")), /needle/);
});

test("leaving Vim search keeps the selected viewport when windowed rendering resumes", () => {
  const tab = createTab(1, "s1", "/repo", {
    vimMode: true,
    chatScrollOffset: 30,
  });
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtimeTab = {
    chat: Array.from({ length: 100 }, (_, index) => ({
      role: "assistant" as const,
      text: `answer ${index}`,
    })),
  } as RuntimeTab;
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  const tui = testTui({ requestRender: () => undefined, hasOverlay: () => false });
  const editor = { getText: () => "", setText: () => undefined };

  renderAgentSurface(tab, runtimeTab, 60, 8);
  tab.vimTranscriptSearch = {
    query: "answer 5",
    selectedIndex: -1,
    resultCount: 0,
    selectionMode: "query",
    anchorRow: 0,
    promptOpen: false,
  };
  const searched = renderAgentSurface(tab, runtimeTab, 60, 8);
  assert.match(stripTerminalSequences(searched.join("\n")), /answer 5/);

  handleMixCodeKeyInput(state, "q", tui, undefined, runtime, undefined, () => false, editor);
  const resumed = renderAgentSurface(tab, runtimeTab, 60, 8);

  assert.match(stripTerminalSequences(resumed.join("\n")), /answer 5/);
});

test("Escape cancels a new search and restores the previous match and viewport", () => {
  const tab = createTab(1, "s1", "/repo", { vimMode: true, chatScrollOffset: 7 });
  tab.vimTranscriptSearch = {
    query: "old",
    selectedIndex: 1,
    resultCount: 2,
    selectedKey: "3:0:3:3",
    selectionMode: "retain",
    anchorRow: 3,
    promptOpen: false,
  };
  const state = createInitialState("/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = { getTab: () => ({ chat: [] }) } as unknown as MixCodeRuntime;
  const harness = createSearchEditorHarness(state, runtime);
  harness.slot.setText("saved draft");

  harness.dispatch("/");
  for (const char of "new") harness.dispatch(char);
  tab.chatScrollOffset = 1;
  harness.dispatch("\x1b");

  assert.equal(tab.vimTranscriptSearch?.query, "old");
  assert.equal(tab.vimTranscriptSearch?.selectedIndex, 1);
  assert.equal(tab.vimTranscriptSearch?.promptOpen, false);
  assert.equal(tab.chatScrollOffset, 7);
  assert.equal(harness.slot.getText(), "saved draft");
});

test("transferring Vim mode to another tab clears tab-local search state", () => {
  const state = createInitialState("/repo");
  const source = createTab(1, "s1", "/repo", { vimMode: true });
  source.vimTranscriptSearch = {
    query: "needle",
    selectedIndex: 0,
    resultCount: 1,
    selectionMode: "retain",
    anchorRow: 0,
    promptOpen: false,
  };
  const destination = createTab(2, "s2", "/repo");
  state.tabs.push(source, destination);
  state.activeTabId = "s1";

  activateTab(state, "s2");

  assert.equal(source.vimMode, false);
  assert.equal(source.vimTranscriptSearch, undefined);
  assert.equal(destination.vimMode, true);
  assert.equal(destination.vimTranscriptSearch, undefined);
});
