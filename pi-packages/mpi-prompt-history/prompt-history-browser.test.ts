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
