import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import {
  bindRuntimeRendering,
  bindWorkingRedraw,
  createMixCodeTui,
  handleMixCodeKeyInput,
  MixCodeRoot,
} from "../src/ui/app.js";
import {
  fitHeadLines,
  fitTailLines,
  renderAgentSurface,
  renderCommandPalette,
  renderQuestionOverlay,
  renderTabJumpOverlay,
  renderFixedTopViewport,
} from "../src/ui/rendering.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { openCommandPalette } from "../src/core/overlays.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";

test("fixed top viewport keeps top rows while clipping growing middle content", () => {
  assert.deepEqual(renderFixedTopViewport(["header", "tabs"], ["old", "new"], ["input"], 4), [
    "header",
    "tabs",
    "new",
    "input",
  ]);
  assert.deepEqual(renderFixedTopViewport(["header"], ["hidden"], ["input"], 2), [
    "header",
    "input",
  ]);
  assert.deepEqual(renderFixedTopViewport(["header", "tabs"], ["hidden"], ["input"], 1), [
    "header",
  ]);
  assert.deepEqual(renderFixedTopViewport(["header"], ["hidden"], ["input"], 0), []);
});

test("head and tail clipping helpers cover empty, one-row, and unchanged layouts", () => {
  assert.deepEqual(fitTailLines(["a"], 2, 10), ["a"]);
  assert.deepEqual(fitTailLines(["a"], 0, 10), []);
  assert.match(fitTailLines(["a", "b"], 1, 10)[0] ?? "", /\.\.\./);
  assert.match(fitTailLines(["a", "b", "c"], 2, 10).join("\n"), /c/);
  assert.deepEqual(fitHeadLines(["a"], 2, 10), ["a"]);
  assert.deepEqual(fitHeadLines(["a"], 0, 10), []);
  assert.match(fitHeadLines(["a", "b"], 1, 10)[0] ?? "", /\.\.\./);
  assert.match(fitHeadLines(["a", "b", "c"], 2, 10).join("\n"), /a/);
});

test("agent surface max height keeps the newest surface rows", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = Array.from({ length: 8 }, (_, index) => ({
    role: "assistant" as const,
    text: `line-${index}`,
  }));
  const lines = renderAgentSurface(tab, { chat, reasoning: [] } as never, 40, 3);
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /\.\.\./);
  assert.match(lines.join("\n"), /line-7/);
});

test("MixCodeRoot caps agent view to keep header and tabs in the terminal viewport", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const chat = Array.from({ length: 40 }, (_, index) => ({
    role: "assistant" as const,
    text: `message-${index}`,
  }));
  const runtime = { getTab: () => ({ chat, reasoning: [] }) } as unknown as MixCodeRuntime;
  const root = new MixCodeRoot(
    state,
    runtime,
    () => 10,
    () => 2,
  );

  const lines = root.render(80);
  assert.equal(lines.length <= 8, true);
  assert.match(lines[0] ?? "", /Agent-01/);
  assert.equal(stripAnsi(lines[1] ?? "").trim(), "");
  assert.doesNotMatch(lines.join("\n"), /message-0/);
  assert.match(lines.join("\n"), /message-39/);
});

test("MixCodeRoot keeps every rendered row within a narrow terminal width", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    todoVisible: true,
    todos: [{ id: "t1", content: "wide todo should not force wrap", status: "pending" }],
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const chat = [
    {
      role: "tool" as const,
      title: "bash",
      status: "success" as const,
      args: { command: "echo one\necho two" },
      text: "ok",
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: "assistant" as const,
      text: `message-${index} ${"long ".repeat(20)}`,
    })),
  ];
  const runtime = {
    getTab: () => ({ chat, reasoning: ["thinking summary"] }),
  } as unknown as MixCodeRuntime;
  const root = new MixCodeRoot(
    state,
    runtime,
    () => 14,
    () => 2,
  );

  const lines = root.render(55);

  assert.equal(
    lines.every((line) => !/[\r\n]/.test(line) && visibleWidth(line) <= 55),
    true,
  );
  assert.match(lines[0] ?? "", /Agent-01/);
  assert.equal(stripAnsi(lines[1] ?? "").trim(), "");
});

test("MixCodeRoot applies chat scroll offset while keeping top rows fixed", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { chatScrollOffset: 1_000_000 });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const chat = Array.from({ length: 40 }, (_, index) => ({
    role: "assistant" as const,
    text: `message-${index}`,
  }));
  const runtime = { getTab: () => ({ chat, reasoning: [] }) } as unknown as MixCodeRuntime;
  const root = new MixCodeRoot(
    state,
    runtime,
    () => 12,
    () => 2,
  );

  const lines = root.render(80);
  assert.equal(lines.length <= 10, true);
  assert.match(lines[0] ?? "", /Agent-01/);
  assert.equal(stripAnsi(lines[1] ?? "").trim(), "");
  assert.match(lines.join("\n"), /message-0/);
  assert.doesNotMatch(lines.join("\n"), /message-39/);
  assert.match(lines.join("\n"), /newer below/);
});

test("MixCodeRoot preserves full output when viewport rows are unavailable", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const chat = Array.from({ length: 20 }, (_, index) => ({
    role: "assistant" as const,
    text: `message-${index}`,
  }));
  const runtime = { getTab: () => ({ chat, reasoning: [] }) } as unknown as MixCodeRuntime;
  const root = new MixCodeRoot(state, runtime);

  const lines = root.render(80);
  assert.equal(lines.length > 8, true);
  assert.match(lines.join("\n"), /message-4/);
  assert.match(lines.join("\n"), /message-19/);
});

test("MixCodeRoot clips config view when viewport is smaller than static content", () => {
  const state = createInitialState("/repo");
  const runtime = { getTab: () => undefined } as unknown as MixCodeRuntime;
  const root = new MixCodeRoot(
    state,
    runtime,
    () => 6,
    () => 1,
  );

  const lines = root.render(80);
  assert.equal(lines.length, 5);
  assert.match(lines[0] ?? "", /MixCode Home/);
});

test("createMixCodeTui renders the combined layout with codex-like editor block and meta row", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      status: "thinking",
      workingStartedAt: new Date(Date.now() - 142_000).toISOString(),
      extensionUi: {
        statuses: [],
        widgets: [],
        toolsExpanded: false,
        pendingUserInteractions: [],
        workingVisible: true,
        header: { lines: ["extension header"] },
        footer: { lines: ["extension footer"] },
      },
    }),
  );
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => ({ chat: [{ role: "assistant", text: "hello" }], reasoning: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  try {
    const lines = tui.render(80);
    const plainLines = lines.map(stripAnsi);
    const inputLine = plainLines.findIndex((line) => /^\s*> /.test(line));
    assert.match(plainLines[0] ?? "", /extension header/);
    assert.match(plainLines.join("\n"), /extension footer/);
    assert.match(lines.join("\n"), /hello/);
    assert.notEqual(inputLine, -1);
    assert.match(plainLines[inputLine - 3] ?? "", /Working/);
    assert.equal(plainLines[inputLine - 2]?.trim(), "");
    assert.equal(lines[inputLine - 2]?.includes("\x1b[48;2;28;28;26m"), false);
    assert.equal(plainLines[inputLine - 1]?.trim(), "");
    assert.equal(lines[inputLine - 1]?.includes("\x1b[48;2;28;28;26m"), true);
    assert.equal(plainLines[inputLine + 1]?.trim(), "");
    assert.equal(lines[inputLine]?.includes("\x1b[48;2;28;28;26m"), true);
    assert.match(plainLines[inputLine + 2] ?? "", /faux\/faux-1/);
    assert.match(plainLines.join("\n"), /Send message to Agent-01\.\.\./);
    assert.doesNotMatch(plainLines.join("\n"), /▊|▔|▁/);
    assert.doesNotMatch(plainLines.join("\n"), /Ctrl\+P/);
  } finally {
    tui.stop();
  }
});

test("createMixCodeTui flattens multiline extension widgets", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      extensionUi: {
        statuses: [],
        widgets: [{ key: "w1", lines: ["widget one\nwidget two"], placement: "aboveEditor" }],
        toolsExpanded: false,
        pendingUserInteractions: [],
        workingVisible: true,
      },
      status: "running",
      workingStartedAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  );
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => ({ chat: [{ role: "assistant", text: "hello" }], reasoning: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  try {
    const lines = tui.render(80);
    const plainLines = lines.map(stripAnsi);
    const output = plainLines.join("\n");
    assert.match(output, /widget one[\s\S]*widget two/);
    assert.ok(output.indexOf("widget two") < output.indexOf("Working"));
    const widgetLine = plainLines.findIndex((line) => /widget two/.test(line));
    const workingLine = plainLines.findIndex((line) => /Working/.test(line));
    assert.notEqual(widgetLine, -1);
    assert.notEqual(workingLine, -1);
    assert.equal(plainLines[workingLine - 1]?.trim(), "");
    assert.equal(workingLine, widgetLine + 2);
  } finally {
    tui.stop();
  }
});

test("createMixCodeTui keeps a blank line between above-editor widgets and editor", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      extensionUi: {
        statuses: [],
        widgets: [{ key: "todos", lines: ["Todos (0/5)", "task five"], placement: "aboveEditor" }],
        toolsExpanded: false,
        pendingUserInteractions: [],
        workingVisible: true,
      },
    }),
  );
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => ({ chat: [], reasoning: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });

  const lines = tui.render(80);
  const plainLines = lines.map(stripAnsi);
  const widgetLine = plainLines.findIndex((line) => /task five/.test(line));
  const inputLine = plainLines.findIndex((line) => /^\s*> /.test(line));
  assert.notEqual(widgetLine, -1);
  assert.notEqual(inputLine, -1);
  assert.equal(plainLines[inputLine - 1]?.trim(), "");
  assert.equal(plainLines[inputLine - 2]?.trim(), "");
  assert.equal(lines[inputLine - 2]?.includes("\x1b[48;2;28;28;26m"), false);
  assert.equal(lines[inputLine - 1]?.includes("\x1b[48;2;28;28;26m"), true);
  assert.equal(inputLine, widgetLine + 3);
});

test("createMixCodeTui keeps a blank line between idle content and editor", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => ({ chat: [{ role: "assistant", text: "last visible answer" }], reasoning: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });

  const plainLines = tui.render(80).map(stripAnsi);
  const inputLine = plainLines.findIndex((line) => /^\s*> /.test(line));
  assert.notEqual(inputLine, -1);
  assert.match(plainLines.slice(0, inputLine).join("\n"), /last visible answer/);
  assert.equal(plainLines[inputLine - 1]?.trim(), "");
});

test("createMixCodeTui does not stack two blank rows above worked status", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { lastWorkedDurationSeconds: 2 }));
  state.activeTabId = "s1";
  const chat = Array.from({ length: 20 }, (_, index) => ({
    role: "assistant" as const,
    text: `message-${index}`,
  }));
  const runtime = {
    getTab: () => ({ chat, reasoning: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });

  const plainLines = tui.render(80).map(stripAnsi);
  const workedLine = plainLines.findIndex((line) => /Worked for/.test(line));
  assert.notEqual(workedLine, -1);
  let blankRows = 0;
  for (let index = workedLine - 1; index >= 0 && plainLines[index]?.trim() === ""; index--) {
    blankRows++;
  }
  assert.equal(blankRows, 1);
});

test("createMixCodeTui pins input meta to the bottom without a trailing blank row", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const chat = [
    ...Array.from({ length: 80 }, (_, index) => ({
      role: "assistant" as const,
      text: `message-${index} ${"long ".repeat(40)}`,
    })),
    {
      role: "tool" as const,
      title: "bash",
      status: "success" as const,
      args: { command: "printf one\nprintf two" },
      text: "ok",
    },
  ];
  const runtime = {
    getTab: () => ({ chat, reasoning: ["thinking summary"] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
  const lines = tui.render(120);
  const plainLines = lines.map(stripAnsi);

  assert.equal(lines.length, 24);
  assert.match(lines[0] ?? "", /Agent-01/);
  assert.match(plainLines.at(-1) ?? "", /faux\/faux-1/);
  assert.match(plainLines.at(-1) ?? "", /Medium/);
  assert.match(plainLines.at(-1) ?? "", /\?\/200k/);
  assert.notEqual(plainLines.at(-1)?.trim(), "");
  assert.equal(
    lines.every((line, index) => visibleWidth(line) <= (index === lines.length - 1 ? 119 : 120)),
    true,
  );
});

test("createMixCodeTui accounts for config and multiline editor row reservations", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const runtime = {
    getTab: () => ({ chat: [{ role: "assistant", text: "hello" }], reasoning: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, {
    completionSources: { skills: [], files: [] },
    terminal: silentTerminal(),
  });

  assert.doesNotMatch(tui.render(80).join("\n"), /> a/);
  state.activeTabId = "s1";
  const layout = (
    tui as unknown as { children: Array<{ editor: { setText: (text: string) => void } }> }
  ).children[0]!;
  layout.editor.setText("a\nb");
  const output = stripAnsi(tui.render(80).join("\n"));

  assert.match(output, /> a/);
  assert.match(output, / {2}b/);
});

test("runtime changes request a differential render without keyboard or mouse input", () => {
  let listener: (() => void) | undefined;
  let renders = 0;
  let force: boolean | undefined;
  const tab = createTab(1, "s1", "/repo");
  const unsubscribe = bindRuntimeRendering(
    {
      onChange: (nextListener) => {
        listener = () => nextListener({ type: "agent_start" } as never, { tab } as never);
        return () => {
          listener = undefined;
        };
      },
    },
    {
      requestRender: (nextForce?: boolean) => {
        renders++;
        force = nextForce;
      },
    },
  );

  listener?.();
  assert.equal(renders, 1);
  assert.equal(force, undefined);
  unsubscribe();
  assert.equal(listener, undefined);
});

test("runtime rendering keeps unread done only for background tabs", () => {
  let listener:
    | ((event: { type: "agent_end" }, runtimeTab: { tab: ReturnType<typeof createTab> }) => void)
    | undefined;
  let renders = 0;
  let persisted = 0;
  const state = createInitialState("/repo");
  const active = createTab(1, "s1", "/repo", { unreadDone: true });
  const background = createTab(2, "s2", "/repo", { unreadDone: true });
  state.tabs.push(active, background);
  state.activeTabId = "s1";

  const unsubscribe = bindRuntimeRendering(
    {
      onChange: (nextListener) => {
        listener = nextListener as typeof listener;
        return () => {
          listener = undefined;
        };
      },
    },
    {
      requestRender: () => {
        renders++;
      },
    },
    state,
    () => {
      persisted++;
    },
  );

  listener?.({ type: "agent_end" }, { tab: active });
  assert.equal(active.unreadDone, false);
  assert.equal(background.unreadDone, true);
  assert.equal(persisted, 1);
  assert.equal(renders, 1);

  listener?.({ type: "agent_end" }, { tab: background });
  assert.equal(background.unreadDone, true);
  assert.equal(persisted, 1);
  assert.equal(renders, 2);
  unsubscribe();
});

test("working indicator requests periodic renders while the active tab is busy", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      extensionUi: { statuses: [], widgets: [], toolsExpanded: false, workingVisible: false },
    }),
  );
  state.activeTabId = "s1";
  let renders = 0;
  let stops = 0;
  const tui = {
    requestRender: () => {
      renders++;
    },
    stop: () => {
      stops++;
    },
  };
  const dispose = bindWorkingRedraw(state, tui);

  await sleep(70);
  assert.equal(renders, 0);
  state.tabs[0]!.status = "running";
  await sleep(95);
  assert.equal(renders > 0, true);
  const runningRenders = renders;
  state.activeTabId = "config";
  await sleep(95);
  assert.equal(renders, runningRenders);
  tui.stop();
  assert.equal(stops, 1);
  state.activeTabId = "s1";
  await sleep(95);
  assert.equal(renders, runningRenders);
  dispose();
});

test("differential renders do not force full redraws after the first paint", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let writes = "";
  const terminal = {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: (data: string) => {
      writes += data;
    },
    get columns() {
      return 120;
    },
    get rows() {
      return 40;
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
  const runtime = {
    getTab: () => ({ chat: [{ role: "assistant", text: "hello" }], reasoning: [] }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal });

  tui.requestRender(true);
  await new Promise((resolve) => process.nextTick(resolve));
  assert.equal(tui.fullRedraws, 1);
  const before = writes.length;
  tui.requestRender();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(tui.fullRedraws, 1);
  assert.equal(writes.slice(before).includes("\x1b[2J"), false);
});

test("working indicator is driven by the Pi TUI loader animation", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "running",
    workingStartedAt: new Date().toISOString(),
    extensionUi: {
      statuses: [],
      widgets: [],
      toolsExpanded: false,
      pendingUserInteractions: [],
      workingVisible: true,
      workingIndicatorFrames: ["A", "B"],
      workingIndicatorIntervalMs: 40,
    },
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let writes = "";
  const terminal: Terminal = {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: (data: string) => {
      writes += data;
    },
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
  const runtime = {
    getTab: () => ({ tab, chat: [], reasoning: [] }),
    onChange: () => () => undefined,
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
  } as unknown as MixCodeRuntime;
  const tui = createMixCodeTui(state, runtime, { terminal });

  try {
    tui.start();
    await sleep(130);
  } finally {
    tui.stop();
  }
  const plain = stripAnsi(writes);
  assert.match(plain, /A Working \(\d+s . esc to interrupt\)/);
  assert.match(plain, /B Working \(\d+s . esc to interrupt\)/);
});

test("key handling covers app overlay handles", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let overlayOpen = false;
  let hides = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return {
        hide: () => {
          hides++;
          overlayOpen = false;
        },
        setHidden: () => undefined,
        isHidden: () => false,
        focus: () => undefined,
        unfocus: () => undefined,
        isFocused: () => false,
      };
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };

  const editorActions = { getText: () => "", setText: () => undefined };
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "@",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editorActions,
      undefined,
    ),
    undefined,
  );
  assert.equal(overlayOpen, false);
  const hidesBeforeHelp = hides;

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1f", tui), { consume: true });
  assert.equal(overlayOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1f", tui), { consume: true });
  assert.equal(hides, hidesBeforeHelp + 1);
  assert.equal(overlayOpen, false);
});

test("rendering overlay defaults cover closed and fallback branches", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    pendingQuestions: [
      {
        requestId: "q",
        sessionId: "s1",
        questions: [
          {
            header: "H",
            question: "Q",
            options: [{ label: "A", description: "Alpha" }],
            multiple: false,
            custom: false,
          },
        ],
        currentQuestionIndex: 0,
        highlightedOptionIndices: [],
        selectedAnswers: [],
        customAnswers: [],
        dirty: false,
      },
    ],
  });
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /> \[ \] A/);
  assert.deepEqual(renderCommandPalette(state, 80), []);
  assert.deepEqual(renderTabJumpOverlay(state, 80), []);
  openCommandPalette(state);
  assert.match(renderCommandPalette(state, 80).join("\n"), /Search commands/);
});

test("handleMixCodeKeyInput lets q pass through to the editor", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };

  assert.equal(
    handleMixCodeKeyInput(state, "q", tui, undefined, undefined, undefined, () => false, {
      getText: () => "draft",
      setText: () => undefined,
    }),
    undefined,
  );
  assert.equal(
    handleMixCodeKeyInput(state, "q", tui, undefined, undefined, undefined, () => true, {
      getText: () => "",
      setText: () => undefined,
    }),
    undefined,
  );
  assert.equal(
    handleMixCodeKeyInput(state, "q", tui, undefined, undefined, undefined, () => false, {
      getText: () => "",
      setText: () => undefined,
    }),
    undefined,
  );
  assert.equal(state.quitConfirmOpen, false);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

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
