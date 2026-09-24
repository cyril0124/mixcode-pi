import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  applyMixCodeSystemPrompt,
  collectContextUsage,
} from "../src/agent/pi-session-internals.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { LOCAL_COMMANDS } from "../src/core/commands.js";
import { computeContextUsage } from "../src/core/context-usage.js";
import { HOME_TAB_ID, type MixCodeTabInfo } from "../src/core/types.js";
import { dispatchAppOverlayInput } from "../src/ui/app-overlays.js";
import { exactContextUsageText } from "../src/ui/rendering/chrome.js";
import {
  createInitialState,
  createTab,
  handleSubmittedInput,
  type MixCodeRuntime,
} from "./helpers/mixcode.js";

interface SessionOptions {
  tokens?: number | null;
  contextLimit?: number;
  /** Make the SDK estimator throw, as it can on degenerate restored history. */
  throws?: boolean;
  /** Leave the active branch without response usage, as before the first reply. */
  noUsage?: boolean;
  /** Append an invalidating entry after the usable usage, as auto-retry does. */
  contextEditAfterUsage?: boolean;
  /** Follow the usable usage with a failed assistant turn carrying usage of its own. */
  abortedTurnAfterUsage?: boolean;
  /** Make the branch's only assistant turn a failed one. */
  abortedTurnOnly?: boolean;
  /** Append an assistant entry that carries no usage at all. */
  usageLessTurnLast?: boolean;
  /** Make a non-estimator session read throw, to exercise the handler's guard. */
  toolsThrow?: boolean;
}

/** Runtime tab stub exposing exactly what `collectContextUsage` reads from Pi. */
function stubTab(options: SessionOptions = {}): { tab: MixCodeTabInfo; runtimeTab: unknown } {
  const tab = createTab(1, "s1", "/repo");
  tab.model = { ...tab.model, provider: "faux", modelId: "faux-1", displayName: "faux/faux-1" };
  if (options.contextLimit !== undefined) tab.contextLimit = options.contextLimit;
  const tokens = options.tokens === undefined ? 100_000 : options.tokens;
  let assembler: ((collected: unknown) => unknown) | undefined;
  const runtimeTab = {
    tab,
    agentSession: {
      // Section keys mirror what MixCode's assembler records for a real session.
      messages: [
        {
          role: "system",
          content: "",
          sections: {
            preamble: "p".repeat(400),
            tools: "t".repeat(120),
            skills: "s".repeat(200),
            project_context:
              '<project_instructions path="/repo/AGENTS.md">\nAGENTS\n</project_instructions>\n\n',
            environment: "Current date: 2026-09-24\n",
          },
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 90_100 },
          timestamp: 1,
          stopReason: "end",
        },
      ],
      // The active branch's last assistant usage decides whether the SDK's number
      // is provider-anchored.
      sessionManager: {
        getBranch: () =>
          options.abortedTurnOnly
            ? [
                {
                  type: "message",
                  id: "a3",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "" }],
                    stopReason: "error",
                    usage: { input: 5_000, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                },
              ]
            : options.noUsage
              ? [{ type: "message", id: "u1", message: { role: "user", content: "hi" } }]
              : [
                  {
                    type: "message",
                    id: "a1",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "ok" }],
                      stopReason: "end",
                      usage: { input: 90_000, output: 100, cacheRead: 0, cacheWrite: 0 },
                    },
                  },
                  ...(options.contextEditAfterUsage ? [{ type: "context_edit", id: "e1" }] : []),
                  ...(options.usageLessTurnLast
                    ? [
                        {
                          type: "message",
                          id: "a4",
                          message: { role: "assistant", content: [{ type: "text", text: "" }] },
                        },
                      ]
                    : []),
                  ...(options.abortedTurnAfterUsage
                    ? [
                        {
                          type: "message",
                          id: "a2",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "" }],
                            stopReason: "aborted",
                            usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
                          },
                        },
                      ]
                    : []),
                ],
      },
      getContextUsage: () => {
        if (options.throws) throw new Error("degenerate history");
        return { tokens, contextWindow: tab.contextLimit, percent: null };
      },
      // Pi renders `systemPrompt` through the installed assembler, which is what
      // makes the pre-first-request section split available.
      get systemPrompt() {
        assembler?.({
          cwd: "/repo",
          selectedTools: ["read"],
          contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rules." }],
          skills: [
            {
              name: "demo-skill",
              description: "a demo skill",
              filePath: "/repo/.agents/skills/demo/SKILL.md",
              baseDir: "/repo/.agents/skills/demo",
              sourceInfo: {},
              disableModelInvocation: false,
            },
          ],
        });
        return "<assembled prompt>";
      },
      getAllTools: () => {
        if (options.toolsThrow) throw new Error("broken extension tool schema");
        return [
          {
            name: "read",
            description: "read a file",
            parameters: { type: "object" },
            sourceInfo: {},
          },
          // Registered but inactive: `defaultTools` left it out, so the panel must
          // not count its schema.
          {
            name: "write",
            description: "write a file into the workdir",
            parameters: { type: "object" },
            sourceInfo: {},
          },
        ];
      },
      getActiveToolNames: () => ["read"],
      setSystemPromptAssembler: (next: (collected: unknown) => unknown) => {
        assembler = next;
      },
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20_000,
          keepRecentTokens: 40_000,
        }),
      },
    },
  };
  return { tab, runtimeTab };
}

function activeState(tab: MixCodeTabInfo) {
  const state = createInitialState("/repo");
  state.tabs = [tab];
  state.activeTabId = tab.sessionId;
  return state;
}

function captureTui(): { tui: Parameters<typeof handleSubmittedInput>[3]; render: () => string } {
  let component: Component | undefined;
  const tui = {
    terminal: { rows: 30, columns: 120 },
    requestRender: () => undefined,
    showOverlay: (next: Component) => {
      component = next;
      return { hide: () => undefined } as never;
    },
  };
  return { tui, render: () => component?.render(120).join("\n") ?? "" };
}

test("/context renders the usage panel for the active tab", async () => {
  const { tab, runtimeTab } = stubTab();
  const state = activeState(tab);
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  const { tui, render } = captureTui();

  await handleSubmittedInput(state, runtime, "/context", tui);
  const plain = Bun.stripANSI(render());

  assert.match(plain, /faux\/faux-1 \(200k context\)/);
  assert.match(plain, /100k\/200k tokens \(50\.0%\)/);
  for (const label of [
    "System prompt:",
    "Project context:",
    "Skills:",
    "Tool guidelines:",
    "Tool schemas:",
    "Messages:",
    "Free space:",
    "Autocompact buffer:",
  ]) {
    assert.ok(plain.includes(label), `panel is missing ${label}`);
  }
  // The panel's window is the same value the status bar prints for this tab.
  assert.ok(exactContextUsageText(tab).includes("200k"));
});

test("/context follows a /context-limit override instead of the model window", async () => {
  const { tab, runtimeTab } = stubTab({ contextLimit: 50_000, tokens: 10_000 });
  const state = activeState(tab);
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  const { tui, render } = captureTui();

  await handleSubmittedInput(state, runtime, "/context", tui);
  const plain = Bun.stripANSI(render());
  assert.match(plain, /50k context/);
  assert.match(plain, /10k\/50k tokens \(20\.0%\)/);
  assert.ok(exactContextUsageText(tab).includes("50k"));
  assert.equal(plain.includes("200k"), false);
});

test("/context reports an unknown total and survives a failing estimator", async () => {
  const unknown = stubTab({ tokens: null });
  const unknownState = activeState(unknown.tab);
  const unknownRuntime = { getTab: () => unknown.runtimeTab } as unknown as MixCodeRuntime;
  const unknownTui = captureTui();
  await handleSubmittedInput(unknownState, unknownRuntime, "/context", unknownTui.tui);
  const unknownPlain = Bun.stripANSI(unknownTui.render());
  assert.match(unknownPlain, /tokens \(\?\)/);
  assert.equal(unknownPlain.includes("Messages:"), false);

  // A throwing SDK estimator degrades to the same estimate-only panel.
  const throwing = stubTab({ throws: true });
  const throwingState = activeState(throwing.tab);
  const throwingRuntime = { getTab: () => throwing.runtimeTab } as unknown as MixCodeRuntime;
  const throwingTui = captureTui();
  await handleSubmittedInput(throwingState, throwingRuntime, "/context", throwingTui.tui);
  assert.match(Bun.stripANSI(throwingTui.render()), /Estimates until the next response\./);
});

test("/context rejects unusable invocations with Error: prefixed messages", async () => {
  const { tab, runtimeTab } = stubTab();
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;

  await assert.rejects(
    () => handleSubmittedInput(activeState(tab), runtime, "/context now", captureTui().tui),
    /Error: Usage: \/context/,
  );

  const noModel = stubTab({ contextLimit: 0 });
  const noModelRuntime = { getTab: () => noModel.runtimeTab } as unknown as MixCodeRuntime;
  await assert.rejects(
    () =>
      handleSubmittedInput(activeState(noModel.tab), noModelRuntime, "/context", captureTui().tui),
    /Error: Context usage is unavailable: no model is selected/,
  );

  // Home tab: dispatch refuses session-scoped commands before the handler runs.
  const homeState = createInitialState("/repo");
  homeState.activeTabId = HOME_TAB_ID;
  await assert.rejects(
    () => handleSubmittedInput(homeState, runtime, "/context", captureTui().tui),
    /Error: No agent to send to/,
  );
});

test("/context marks an SDK estimate that no response has confirmed", async () => {
  // The SDK returns a numeric estimate before any response reports usage (session
  // usage totals are still zero); it is not a provider anchor, so the panel must
  // mark it as an estimate.
  const { tab, runtimeTab } = stubTab({ noUsage: true });
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  const { tui, render } = captureTui();

  await handleSubmittedInput(activeState(tab), runtime, "/context", tui);
  const plain = Bun.stripANSI(render());
  assert.match(plain, /~100k\/200k tokens \(\?\)/);
  assert.match(plain, /Estimates until the next response\./);
  assert.equal(plain.includes("Estimates; total from the last response."), false);
});

test("/context ignores usage that a later context edit invalidated", async () => {
  // Auto-retry appends `context_edit` after an abandoned attempt; Pi then reports a
  // pure estimate, so the panel must not present the old usage as an anchor.
  const { tab, runtimeTab } = stubTab({ contextEditAfterUsage: true });
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  const { tui, render } = captureTui();

  await handleSubmittedInput(activeState(tab), runtime, "/context", tui);
  const plain = Bun.stripANSI(render());
  assert.match(plain, /~100k\/200k tokens \(\?\)/);
  assert.match(plain, /Estimates until the next response\./);
});

test("/context reports a failing session read with the Error: prefix", async () => {
  const { tab, runtimeTab } = stubTab({ toolsThrow: true });
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;

  await assert.rejects(
    () => handleSubmittedInput(activeState(tab), runtime, "/context", captureTui().tui),
    /Error: Context usage is unavailable: broken extension tool schema/,
  );
});

test("/context ignores failed turns when it looks for an anchor", async () => {
  // Pi skips aborted and error turns when it picks the usage to anchor on, so the
  // panel must not treat a failed turn as the session's provider anchor.
  const trailing = stubTab({ abortedTurnAfterUsage: true });
  const trailingRuntime = { getTab: () => trailing.runtimeTab } as unknown as MixCodeRuntime;
  const trailingTui = captureTui();
  await handleSubmittedInput(
    activeState(trailing.tab),
    trailingRuntime,
    "/context",
    trailingTui.tui,
  );
  const anchoredPlain = Bun.stripANSI(trailingTui.render());
  assert.match(anchoredPlain, /100k\/200k tokens \(50\.0%\)/);
  assert.equal(anchoredPlain.includes("~100k"), false, "the earlier real usage still anchors");

  const only = stubTab({ noUsage: true, abortedTurnOnly: true });
  const onlyRuntime = { getTab: () => only.runtimeTab } as unknown as MixCodeRuntime;
  const onlyTui = captureTui();
  await handleSubmittedInput(activeState(only.tab), onlyRuntime, "/context", onlyTui.tui);
  assert.match(Bun.stripANSI(onlyTui.render()), /~100k\/200k tokens \(\?\)/);
});

test("/context keeps its anchor when the branch holds a usage-less assistant entry", async () => {
  // `calculateContextTokens` throws on a missing usage; a malformed entry must not
  // drop the anchor Pi would still use.
  const { tab, runtimeTab } = stubTab({ usageLessTurnLast: true });
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  const { tui, render } = captureTui();

  await handleSubmittedInput(activeState(tab), runtime, "/context", tui);
  const plain = Bun.stripANSI(render());
  assert.match(plain, /100k\/200k tokens \(50\.0%\)/);
  assert.equal(plain.includes("~100k"), false);
});

test("/context closes on q as its hint promises", async () => {
  const { tab, runtimeTab } = stubTab();
  const runtime = { getTab: () => runtimeTab } as unknown as MixCodeRuntime;
  let component: Component | undefined;
  let hidden = 0;
  const tui = {
    terminal: { rows: 30, columns: 120 },
    requestRender: () => undefined,
    showOverlay: (next: Component) => {
      component = next;
      return { hide: () => hidden++ } as never;
    },
  };

  await handleSubmittedInput(activeState(tab), runtime, "/context", tui);
  assert.ok(component?.render(120).length, "panel is open before the key");
  assert.equal(dispatchAppOverlayInput(tui, "q"), true);
  assert.equal(hidden, 1, "q must close the panel, not fall through to the editor");
});

test("/context uses the session's assembled prompt before the first request", () => {
  // Nothing is recorded in the transcript yet: the split must come from rendering
  // the session's own prompt, which runs the assembler MixCode installed.
  const { tab, runtimeTab } = stubTab();
  const session = (runtimeTab as { agentSession: Record<string, unknown> }).agentSession;
  session.messages = [];
  applyMixCodeSystemPrompt(session as unknown as AgentSession, { hasRg: true, hasFd: true });

  const snapshot = collectContextUsage(runtimeTab as RuntimeTab);
  const names = snapshot.input.sections.map((section) => section.name);
  assert.ok(names.includes("skills"), `skills section must survive: ${names.join(",")}`);
  // `project_context` splits into per-file rows plus its frame.
  assert.ok(names.some((name) => name.startsWith("project_context")));
  assert.ok(names.includes("environment"));

  const categories = computeContextUsage(snapshot.input).categories;
  const skills = categories.find((category) => category.id === "skills");
  assert.ok((skills?.tokens ?? 0) > 0, "Skills covers a real cost before the first request");
  assert.equal(tab.contextLimit, snapshot.input.contextWindow);
});

test("/context is registered as a session-scoped palette command", () => {
  const entry = LOCAL_COMMANDS.find((command) => command.name === "context");
  assert.ok(entry, "/context must be registered in LOCAL_COMMANDS");
  assert.equal(entry.argumentHint, undefined);
  assert.equal(entry.palette?.requires, "session");
  assert.ok(entry.description.length > 0);
});

test("context usage counts only the tools this session sends", () => {
  const { tab, runtimeTab } = stubTab();
  const snapshot = collectContextUsage(runtimeTab as RuntimeTab);

  assert.equal(snapshot.input.contextWindow, tab.contextLimit);
  assert.equal(snapshot.input.anchored, true, "provider usage makes the total provider-anchored");
  assert.equal(snapshot.input.toolTexts.length, 1, "the inactive `write` tool must not be counted");
  assert.match(snapshot.input.toolTexts[0] ?? "", /^read\nread a file\n/);
  assert.equal(snapshot.modelName, tab.model.displayName);
});
