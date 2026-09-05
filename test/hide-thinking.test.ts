import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { OverlayTui } from "../src/ui/app-types.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { renderChatBlock } from "../src/ui/rendering/chat.js";
import { MIXCODE_DARK_THEME } from "../src/ui/themes.js";
import { visibleWidth } from "@earendil-works/pi-tui";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("/hide-thinking toggles state, persists via runtime, and toasts", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  assert.equal(state.hideThinkingBlock ?? false, false);

  const persisted: boolean[] = [];
  const runtime = {
    getTab: () => undefined,
    setHideThinkingBlock: (hide: boolean) => persisted.push(hide),
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  // Toggle on.
  await handleSubmittedInput(state, runtime, "/hide-thinking", tui);
  assert.equal(state.hideThinkingBlock, true);
  assert.deepEqual(persisted, [true]);
  assert.match(state.tabs[0]?.toast?.message ?? "", /hidden/i);

  // Toggle off.
  await handleSubmittedInput(state, runtime, "/hide-thinking", tui);
  assert.equal(state.hideThinkingBlock, false);
  assert.deepEqual(persisted, [true, false]);
  assert.match(state.tabs[0]?.toast?.message ?? "", /visible/i);
});

test("/hide-thinking from Home pushes toast on the selected agent", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const runtime = {
    getTab: () => undefined,
    setHideThinkingBlock: () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(
    state,
    runtime,
    "/hide-thinking",
    tui,
    undefined,
    undefined,
    undefined,
    state.tabs[0],
  );

  assert.equal(state.hideThinkingBlock, true);
  assert.match(state.tabs[0]?.toast?.message ?? "", /Thinking blocks: hidden/i);
});

test("/hide-thinking keeps state unchanged when persistence fails", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const messages: string[] = [];
  const runtime = {
    appendSystemMessage: (_sessionId: string, message: string) => messages.push(message),
    getTab: () => undefined,
    setHideThinkingBlock: () => {
      throw new Error("settings disk is read-only");
    },
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined } as unknown as OverlayTui;

  await handleSubmittedInput(state, runtime, "/hide-thinking", tui);

  assert.equal(state.hideThinkingBlock ?? false, false);
  assert.equal(state.tabs[0]?.toast, undefined);
  assert.deepEqual(messages, ["Hide thinking failed: settings disk is read-only"]);
});

test("renderAgentSurface keeps short hidden thinking in the tail window", () => {
  const chat = [
    { role: "thinking", text: "secret reasoning trace" },
    { role: "assistant", text: "final answer" },
  ];

  const visible = stripAnsi(
    renderAgentSurface(createTab(1, "s1", "/repo"), { chat } as never, 100).join("\n"),
  );
  assert.match(visible, /secret reasoning trace/);
  assert.match(visible, /final answer/);

  const hidden = stripAnsi(
    renderAgentSurface(createTab(2, "s2", "/repo"), { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  // Short thinking stays visible in the 3-row window; assistant text stays.
  assert.match(hidden, /secret reasoning trace/);
  assert.doesNotMatch(hidden, /Thinking\.\.\./);
  assert.match(hidden, /final answer/);
});

test("hidden thinking defaults to the Thinking... placeholder without the boxed setting", () => {
  const chat = [
    { role: "thinking", text: thinkingLines("line").join("\n") },
    { role: "assistant", text: "final answer" },
  ];

  const hidden = stripAnsi(
    renderAgentSurface(createTab(1, "s1", "/repo"), { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: false,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking\.\.\./);
  assert.doesNotMatch(hidden, /line-19/);
  assert.doesNotMatch(hidden, /╭/);
  assert.match(hidden, /final answer/);
});

test("hidden thinking placeholder uses extensionUi.hiddenThinkingLabel when set", () => {
  const chat = [{ role: "thinking", text: thinkingLines("line").join("\n") }];
  const tab = createTab(1, "s1", "/repo");
  tab.extensionUi.hiddenThinkingLabel = "Reasoning folded";

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.doesNotMatch(hidden, /line-19/);
  assert.match(hidden, /Reasoning folded/);

  tab.extensionUi.hiddenThinkingLabel = undefined;
  const restored = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(restored, /line-19/);
  assert.doesNotMatch(restored, /Reasoning folded/);

  // Label also wins in default placeholder mode.
  tab.extensionUi.hiddenThinkingLabel = "Reasoning folded";
  const plain = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: false,
    }).join("\n"),
  );
  assert.match(plain, /Reasoning folded/);
  assert.doesNotMatch(plain, /line-19/);
  assert.doesNotMatch(plain, /Thinking\.\.\./);
});

test("hidden thinking rail separates its title, muted rail, and upright body", () => {
  const theme = MIXCODE_DARK_THEME;
  const lines = renderChatBlock({ role: "thinking", text: "reasoning" }, 40, undefined, theme, {
    hideThinking: true,
    boxedHiddenThinking: true,
  });
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes(theme.text("Thinking")));
  assert.ok(lines[1]!.includes(theme.thinkingText("reasoning")));
  assert.ok(lines[1]!.includes(theme.borderMuted("│")));
  assert.doesNotMatch(lines.join("\n"), /\x1b\[3m/);
  assert.doesNotMatch(stripAnsi(lines.join("\n")), /[╭╮╰╯─]/u);
});

test("hidden thinking rail keeps its indent and right gutter when wrapping ASCII and full-width text", () => {
  for (const width of [20, 40, 100]) {
    for (const text of ["x".repeat(1000), "中文".repeat(500)]) {
      const lines = renderChatBlock({ role: "thinking", text }, width, undefined, undefined, {
        hideThinking: true,
        boxedHiddenThinking: true,
      }).map(stripAnsi);
      assert.equal(lines.length, 4);
      for (const line of lines) assert.equal(visibleWidth(line), width);
      for (const line of lines.slice(1)) assert.match(line, /^ {2}│ [^│]* $/u);
      assert.match(lines[1]!, /^ {2}│ … /u);
    }
  }
});

test("hidden thinking rail right-aligns the dimmed duration without exceeding narrow widths", () => {
  const theme = MIXCODE_DARK_THEME;
  for (const width of [1, 8, 20, 40, 100]) {
    const lines = renderChatBlock(
      { role: "thinking", text: "reasoning", thinkingStartedAt: 1000, thinkingEndedAt: 2420 },
      width,
      undefined,
      theme,
      { hideThinking: true, boxedHiddenThinking: true },
    );
    for (const line of lines) assert.equal(visibleWidth(line), width);
    if (width >= 20) {
      const header = stripAnsi(lines[0]!);
      assert.match(header, /^ {2}Thinking\s+1\.4s $/u);
      assert.ok(lines[0]!.includes(theme.dim(" 1.4s")));
    }
  }
});

function thinkingLines(text: string): string[] {
  return Array.from({ length: 20 }, (_, index) => `${text}-${String(index).padStart(2, "0")}`);
}

test("hidden thinking viewport shows a 3-row tail of that block", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: thinkingLines("line").join("\n") }];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  const content = hidden
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(content.length, 4);
  assert.match(content[0]!, /Thinking/);
  assert.match(content[1]!, /… line-17/);
  assert.match(content[2]!, /line-18/);
  assert.match(content[3]!, /line-19/);
  assert.doesNotMatch(hidden, /[╭╮╰╯─]/u);
  assert.doesNotMatch(hidden, /line-00/);
  assert.doesNotMatch(hidden, /Thinking\.\.\./);
});

test("hidden thinking viewport follows the tail as text grows", () => {
  const tab = createTab(1, "s1", "/repo");
  const short = [{ role: "thinking", text: thinkingLines("line").slice(0, 11).join("\n") }];
  const first = stripAnsi(
    renderAgentSurface(tab, { chat: short } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(first, /line-10/);
  assert.doesNotMatch(first, /line-19/);

  const long = [{ role: "thinking", text: thinkingLines("line").join("\n") }];
  const second = stripAnsi(
    renderAgentSurface(tab, { chat: long } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(second, /line-19/);
  assert.doesNotMatch(second, /line-10/);
});

test("hidden thinking viewport keeps short text without an ellipsis", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: "one\ntwo" }];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking/);
  assert.match(hidden, /one/);
  assert.match(hidden, /two/);
  assert.match(hidden, / {2}│ one/);
  assert.match(hidden, / {2}│ two/);
  assert.doesNotMatch(hidden, /[╭╮╰╯─]/u);
  assert.doesNotMatch(hidden, /…/);
});

test("hidden thinking viewport of a long body is 3 rows and drops the head", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [
    {
      role: "thinking",
      text: `HEAD-UNIQUE\n${"x".repeat(100_000)}\nTAIL-UNIQUE`,
    },
  ];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 40, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  const content = hidden
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(content.length, 4);
  assert.match(hidden, /Thinking/);
  assert.match(hidden, /TAIL-UNIQUE/);
  assert.doesNotMatch(hidden, /HEAD-UNIQUE/);
});

test("visible thinking is not truncated when hideThinking is off", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: thinkingLines("line").join("\n") }];

  const visible = stripAnsi(renderAgentSurface(tab, { chat } as never, 100).join("\n"));
  assert.match(visible, /line-00/);
  assert.match(visible, /line-19/);
});

test("boxed hidden thinking refreshes subsecond timing without new text and freezes on completion", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const tab = createTab(1, "s1", "/repo");
  tab.status = "thinking";
  const line = {
    role: "thinking",
    text: thinkingLines("line").join("\n"),
    thinkingStartedAt: 1000,
    thinkingEndedAt: undefined as number | undefined,
  };
  const runtimeTab = {
    chat: [line],
    streamingAssistant: {
      chatIndex: 0,
      blockIndices: new Map([[0, 0]]),
      toolCallIndices: new Map(),
    },
  };
  const render = () =>
    stripAnsi(
      renderAgentSurface(tab, runtimeTab as never, 100, undefined, undefined, {
        hideThinking: true,
        boxedHiddenThinking: true,
      }).join("\n"),
    );

  for (const [elapsed, label] of [
    [0, "0ms"],
    [320, "320ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [1420, "1.4s"],
    [1520, "1.5s"],
    [59_999, "59.9s"],
    [60_000, "1m 00s"],
  ] as const) {
    now = 1000 + elapsed;
    assert.ok(render().split("\n")[0]!.trimEnd().endsWith(` ${label}`), `elapsed ${elapsed}`);
  }

  now = 2420;
  assert.match(render(), /Thinking +1\.4s /);
  line.thinkingEndedAt = now;
  assert.match(render(), /Thinking +1\.4s /);
  now += 10_000;
  assert.match(render(), /Thinking +1\.4s /);
});

for (const [elapsed, label] of [
  [0, "0ms"],
  [320, "320ms"],
  [999, "999ms"],
  [1000, "1.0s"],
  [1426, "1.4s"],
  [59_998, "59.9s"],
  [60_000, "1m 00s"],
  [3_661_000, "1h 01m 01s"],
] as const) {
  test(`boxed hidden thinking freezes ${elapsed}ms as ${label}`, () => {
    const tab = createTab(1, `finished-${elapsed}`, "/repo");
    const chat = [
      {
        role: "thinking",
        text: "reasoning",
        thinkingStartedAt: 1000,
        thinkingEndedAt: 1000 + elapsed,
      },
    ];
    const hidden = stripAnsi(
      renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
        hideThinking: true,
        boxedHiddenThinking: true,
      }).join("\n"),
    );
    assert.ok(hidden.split("\n")[0]!.trimEnd().endsWith(` ${label}`));
  });
}

test("boxed hidden thinking freezes the timer once the message ended", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [
    {
      role: "thinking",
      text: thinkingLines("line").join("\n"),
      thinkingStartedAt: 1000,
      thinkingEndedAt: 1000 + 65_000,
    },
  ];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking +1m 05s/);
});

test("boxed hidden thinking title has no timer for restored history blocks", () => {
  const tab = createTab(1, "s1", "/repo");
  const chat = [{ role: "thinking", text: "restored reasoning" }];

  const hidden = stripAnsi(
    renderAgentSurface(tab, { chat } as never, 100, undefined, undefined, {
      hideThinking: true,
      boxedHiddenThinking: true,
    }).join("\n"),
  );
  assert.match(hidden, /Thinking/);
  assert.equal(hidden.split("\n")[0]!.trim(), "Thinking");
});
