import assert from "node:assert/strict";
import { test } from "node:test";
import { createPromptHistoryBrowserComponent } from "./prompt-history-browser.js";

const theme = {
  bold: (s: string) => s,
  fg: (_color: string, text: string) => text,
};

test("Enter on empty filter stays open instead of closing", () => {
  const results: Array<string | null> = [];
  const browser = createPromptHistoryBrowserComponent({
    tui: {
      terminal: { columns: 80, rows: 24 },
      requestRender: () => undefined,
    },
    theme: theme as never,
    items: [
      { entryId: "1", text: "HISTORY-ITEM-ALPHA" },
      { entryId: "2", text: "HISTORY-ITEM-BETA" },
    ],
    done: (result) => results.push(result),
  });

  for (const ch of "NO-SUCH-HISTORY") browser.handleInput(ch);
  assert.match(browser.render(80).join("\n"), /No matching prompts/);

  browser.handleInput("\r");
  assert.deepEqual(results, []);
  assert.match(browser.render(80).join("\n"), /No matching prompts/);

  // Selecting a real match still closes with the prompt text.
  browser.handleInput("\x1b"); // clear query
  browser.handleInput("\r");
  assert.deepEqual(results, ["HISTORY-ITEM-BETA"]);
});

test("Up from first item wraps to last, Down from last wraps to first", () => {
  const results: Array<string | null> = [];
  const browser = createPromptHistoryBrowserComponent({
    tui: {
      terminal: { columns: 80, rows: 24 },
      requestRender: () => undefined,
    },
    theme: theme as never,
    items: [
      { entryId: "1", text: "HISTORY-ITEM-ALPHA" },
      { entryId: "2", text: "HISTORY-ITEM-BETA" },
      { entryId: "3", text: "HISTORY-ITEM-GAMMA" },
    ],
    done: (result) => results.push(result),
  });

  // Newest-first: selected starts at GAMMA. Up wraps to ALPHA (last).
  browser.handleInput("\x1b[A");
  browser.handleInput("\r");
  assert.deepEqual(results, ["HISTORY-ITEM-ALPHA"]);

  const wrapResults: Array<string | null> = [];
  const browser2 = createPromptHistoryBrowserComponent({
    tui: {
      terminal: { columns: 80, rows: 24 },
      requestRender: () => undefined,
    },
    theme: theme as never,
    items: [
      { entryId: "1", text: "HISTORY-ITEM-ALPHA" },
      { entryId: "2", text: "HISTORY-ITEM-BETA" },
      { entryId: "3", text: "HISTORY-ITEM-GAMMA" },
    ],
    done: (result) => wrapResults.push(result),
  });

  // Down twice reaches ALPHA, one more Down wraps to GAMMA (first).
  browser2.handleInput("\x1b[B");
  browser2.handleInput("\x1b[B");
  browser2.handleInput("\x1b[B");
  browser2.handleInput("\r");
  assert.deepEqual(wrapResults, ["HISTORY-ITEM-GAMMA"]);
});
