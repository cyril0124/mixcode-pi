import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createQuestionRequest,
  createTab,
  expandLocalPromptCommand,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  renderQuestionOverlay,
  renderShellOverlay,
  tabBarHitRegions,
  setTheme,
  themeForId,
  themeSuggestions,
} from "../src/index.js";
import type { MixCodeRuntime } from "../src/index.js";
import type { Model } from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL } from "../src/index.js";

type TestChatLine = { role: "system"; text: string };

function assertQuitOverlay(text: string | undefined): void {
  assert.match(text ?? "", /┌/);
  assert.match(text ?? "", /Quit MixCode/);
  assert.match(text ?? "", /\[Y\] Quit/);
}

async function waitFor<T>(read: () => Promise<T>, attempts = 25): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test("export chooser escape branch closes without a visible overlay handle", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.exportChooserOpen = true;
  state.exportChooserIndex = 2;
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.exportChooserOpen, false);
  assert.equal(state.exportChooserIndex, 0);
  assert.equal(renders, 1);
});

test("export chooser exposes missing runtime and active tab errors", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => true,
  };

  state.exportChooserOpen = true;
  assert.throws(() => handleMixCodeKeyInput(state, "t", tui), /runtime tab access/);
  assert.equal(state.exportChooserOpen, true);
  assert.throws(
    () => handleMixCodeKeyInput(state, "t", tui, undefined, { getTab: () => undefined }),
    /Unknown tab session/,
  );
  state.tabs.length = 0;
  state.activeTabId = "missing";
  assert.throws(
    () => handleMixCodeKeyInput(state, "t", tui, undefined, { getTab: () => undefined }),
    /No active tab/,
  );
});

test("global key input answers and rejects pending questions through runtime prompt", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.pendingQuestions.push(
    createQuestionRequest("r1", "s1", [
      {
        header: "Choice",
        question: "Pick one",
        options: [
          { label: "A", description: "Alpha" },
          { label: "B", description: "Beta" },
        ],
        multiple: false,
        custom: false,
      },
      {
        header: "Why",
        question: "Pick many",
        options: [
          { label: "C", description: "Gamma" },
          { label: "D", description: "Delta" },
        ],
        multiple: true,
        custom: true,
      },
    ]),
  );
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  const overlays: string[] = [];
  const prompts: string[] = [];
  const tui = {
    requestRender: () => renders++,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const runtime = {
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text);
    },
  };
  const changes: string[] = [];

  assert.deepEqual(
    handleMixCodeKeyInput(state, "j", tui, undefined, runtime, () => changes.push("changed")),
    { consume: true },
  );
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[0], 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "k", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[0], 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[0], 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[0], 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1A", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[0], 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1B", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[0], 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.deepEqual(tab.pendingQuestions[0]?.selectedAnswers[0], ["B"]);
  assert.deepEqual(handleMixCodeKeyInput(state, " ", tui, undefined, runtime), { consume: true });
  assert.deepEqual(tab.pendingQuestions[0]?.selectedAnswers[0], []);
  assert.deepEqual(handleMixCodeKeyInput(state, " ", tui, undefined, runtime), { consume: true });
  assert.deepEqual(tab.pendingQuestions[0]?.selectedAnswers[0], ["B"]);
  assert.deepEqual(handleMixCodeKeyInput(state, "l", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, " ", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, " ", tui, undefined, runtime), { consume: true });
  assert.deepEqual(tab.pendingQuestions[0]?.selectedAnswers[1], ["C", "D"]);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 2);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, 1);
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /> \[\*\] Custom: \(empty\)/);
  for (const char of "because") {
    assert.deepEqual(handleMixCodeKeyInput(state, char, tui, undefined, runtime), {
      consume: true,
    });
  }
  assert.equal(tab.pendingQuestions[0]?.customAnswers[1], "because");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1A", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 2);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.customAnswers[1], "becausej");
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.customAnswers[1], "because");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 2);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "q", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.customAnswers[1], "becauseq");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1B", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 2);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.highlightedOptionIndices[1], 2);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1D", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1C", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.customAnswers[1], "because");
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.customAnswers[1], "becaus");
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.editingCustomIndex, undefined);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "h", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingQuestions[0]?.currentQuestionIndex, 0);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "y", tui, undefined, runtime, () => changes.push("changed")),
    { consume: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.pendingQuestions.length, 0);
  assert.match(prompts[0] ?? "", /Selected answers: B/);
  assert.match(prompts[0] ?? "", /Selected answers: C, D/);
  assert.match(prompts[0] ?? "", /Custom answer: becaus/);
  assert.deepEqual(changes, ["changed"]);

  tab.pendingQuestions.push(
    createQuestionRequest("r2", "s1", [
      { header: "Again", question: "Reject?", options: [], multiple: false, custom: false },
    ]),
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "x", tui, undefined, runtime), undefined);
  assert.throws(() => handleMixCodeKeyInput(state, "y", tui), /requires runtime prompt support/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingQuestions.length, 1);
  assert.equal(tab.pendingEscapeAction, "reject-question");
  assert.match(renderQuestionOverlay(tab, 80).join("\n"), /Esc again: reject question/);
  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, () => changes.push("changed")),
    { consume: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.pendingQuestions.length, 0);
  assert.match(prompts[1] ?? "", /rejected by user/);

  tab.pendingQuestions.push(
    createQuestionRequest("r2b", "s1", [
      { header: "Again", question: "Reject again?", options: [], multiple: false, custom: false },
    ]),
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "n", tui, undefined, runtime), { consume: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.pendingQuestions.length, 0);
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.match(prompts[2] ?? "", /rejected by user/);

  const failingRuntime = {
    prompt: async () => {
      throw new Error("submit failed");
    },
  };
  tab.pendingQuestions.push(
    createQuestionRequest("r3", "s1", [
      { header: "Fail", question: "Keep?", options: [], multiple: false, custom: false },
    ]),
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, failingRuntime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.pendingQuestions.length, 1);
  assert.match(overlays.at(-1) ?? "", /submit failed/);

  const stringFailingRuntime = {
    prompt: async () => {
      throw "string submit failed";
    },
  };
  tab.pendingQuestions = [
    createQuestionRequest("r4", "s1", [
      { header: "String Fail", question: "Keep?", options: [], multiple: false, custom: false },
    ]),
  ];
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, stringFailingRuntime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.pendingQuestions.length, 1);
  assert.match(overlays.at(-1) ?? "", /string submit failed/);
  assert.ok(renders >= 9);
});
