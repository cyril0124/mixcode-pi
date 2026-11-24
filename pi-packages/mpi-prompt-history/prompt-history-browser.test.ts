import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPromptHistoryBrowserComponent } from "./prompt-history-browser.js";

const theme = {
  getBgAnsi: (_color: string) => "\x1b[43m",
  bg: (_color: string, text: string) => text,
  bold: (s: string) => s,
  fg: (_color: string, text: string) => text,
};

test("search uses a case-insensitive regular expression", () => {
  const results: Array<string | null> = [];
  const browser = createPromptHistoryBrowserComponent({
    tui: { terminal: { columns: 80, rows: 24 }, requestRender: () => undefined },
    theme: theme as never,
    items: [{ text: "alpha 123" }, { text: "beta" }, { text: "ALPHA 456" }],
    done: (result) => results.push(result),
  });

  browser.handleInput("/");
  for (const ch of "alpha \\d+") browser.handleInput(ch);
  browser.handleInput("\r");
  assert.deepEqual(results, ["ALPHA 456"]);
});

test("invalid regular expressions are shown in the browser", () => {
  const browser = createPromptHistoryBrowserComponent({
    tui: { terminal: { columns: 80, rows: 24 }, requestRender: () => undefined },
    theme: theme as never,
    items: [{ text: "alpha" }],
    done: () => undefined,
  });

  browser.handleInput("/");
  for (const ch of "[") browser.handleInput(ch);
  assert.match(browser.render(80).join("\n"), /Invalid regex:/);
});

test("Enter on empty filter stays open instead of closing", () => {
  const results: Array<string | null> = [];
  const browser = createPromptHistoryBrowserComponent({
    tui: {
      terminal: { columns: 80, rows: 24 },
      requestRender: () => undefined,
    },
    theme: theme as never,
    items: [{ text: "HISTORY-ITEM-ALPHA" }, { text: "HISTORY-ITEM-BETA" }],
    done: (result) => results.push(result),
  });

  browser.handleInput("/");
  for (const ch of "NO-SUCH-HISTORY") browser.handleInput(ch);
  assert.match(browser.render(80).join("\n"), /No matching prompts/);

  browser.handleInput("\r");
  assert.deepEqual(results, []);
  assert.match(browser.render(80).join("\n"), /No matching prompts/);

  // Selecting a real match still closes with the prompt text.
  browser.handleInput("\x1b"); // cancel search, clear query
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
      { text: "HISTORY-ITEM-ALPHA" },
      { text: "HISTORY-ITEM-BETA" },
      { text: "HISTORY-ITEM-GAMMA" },
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
      { text: "HISTORY-ITEM-ALPHA" },
      { text: "HISTORY-ITEM-BETA" },
      { text: "HISTORY-ITEM-GAMMA" },
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

// ─── Scope toggle (Ctrl+G) ───────────────────────────────────────────────────

const CTRL_G = "\x07";
const MATCH_BG = "\x1b[43m";
const MATCH_FG = "\x1b[30m";

function highlightedText(line: string): string[] {
  return line
    .split(MATCH_BG)
    .slice(1)
    .map((span) => stripVTControlCharacters(span.split(/\x1b\[(?:49|0)m/, 1)[0] ?? ""));
}

test("visible regex matches get a theme background as the search and scope change", async () => {
  const results: Array<string | null> = [];
  const original = "İ中文 ALpha\nalpha " + "alpha ".repeat(20);
  const unicodePrompt = "Family 👩‍👩‍👧‍👧";
  const browser = createPromptHistoryBrowserComponent({
    tui: { terminal: { columns: 80, rows: 24 }, requestRender() {} },
    theme: {
      fg: (token: string, text: string) => {
        if (token === "searchMatchText") return `${MATCH_FG}${text}\x1b[39m`;
        return `\x1b[36m${text}\x1b[39m`;
      },
      getBgAnsi: (token: string) => {
        assert.equal(token, "searchMatchBg");
        return MATCH_BG;
      },
      bg: (token: string, text: string) => {
        assert.equal(token, "searchMatchBg");
        return `${MATCH_BG}${text}\x1b[49m`;
      },
    } as never,
    items: [{ text: unicodePrompt }, { text: "Earlier alpha" }, { text: original }],
    loadGlobalItems: async () => [{ text: "Global ALPHA" }],
    done: (result) => results.push(result),
  });

  browser.handleInput("/");
  browser.handleInput("alpha");
  const rows = browser.render(80);
  const originalRow = rows.find((line) => line.includes("İ中文")) ?? "";
  assert.deepEqual(highlightedText(originalRow).slice(0, 2), ["ALpha", "alpha"]);
  assert.deepEqual(highlightedText(rows.find((line) => line.includes("Earlier")) ?? ""), ["alpha"]);
  assert.ok(originalRow.includes(MATCH_BG + MATCH_FG));

  browser.handleInput("\x7f");
  assert.deepEqual(highlightedText(browser.render(80).find((line) => line.includes("Earlier")) ?? ""), ["alph"]);
  const narrow = browser.render(20).find((line) => line.includes("İ中文")) ?? "";
  assert.equal(visibleWidth(narrow), 20);
  assert.deepEqual(highlightedText(narrow), ["AL"]);
  assert.match(narrow, /\x1b\[0m\.\.\./);

  browser.handleInput(CTRL_G);
  assert.match(stripVTControlCharacters(browser.render(80).join("\n")), /Loading global history/);
  await new Promise((resolve) => setImmediate(resolve));
  const globalRow = browser.render(80).find((line) => line.includes("Global ") && line.includes(MATCH_BG));
  assert.deepEqual(highlightedText(globalRow ?? ""), ["ALPH"]);
  browser.handleInput(CTRL_G);
  browser.handleInput("\x1b");
  assert.ok(browser.render(80).every((line) => !line.includes(MATCH_BG)));

  browser.handleInput("/");
  browser.handleInput("👩");
  const unicodeRow = browser.render(80).find((line) => line.includes("Family")) ?? "";
  assert.deepEqual(highlightedText(unicodeRow), ["👩‍👩‍👧‍👧"]);

  browser.handleInput("\x1b");
  browser.handleInput("/");
  browser.handleInput("(?=alpha)");
  assert.ok(browser.render(80).every((line) => !line.includes(MATCH_BG)));
  browser.handleInput("\r");
  assert.deepEqual(results, [original]);
});

test("search highlights with a background when the theme does not supply one", () => {
  const browser = createPromptHistoryBrowserComponent({
    tui: { terminal: { columns: 80, rows: 24 }, requestRender() {} },
    theme: { ...theme, getBgAnsi: () => "\x1b[49m" } as never,
    items: [{ text: "Before alpha after" }],
    done() {},
  });

  browser.handleInput("/");
  browser.handleInput("alpha");
  const row = browser.render(80).find((line) => line.includes("Before")) ?? "";
  assert.match(row, /Before \x1b\[30;103malpha\x1b\[39;49m after/);
});

test("search styles only the visible prefix of a long non-ASCII prompt", () => {
  const styledMatches: string[] = [];
  const browser = createPromptHistoryBrowserComponent({
    tui: { terminal: { columns: 80, rows: 24 }, requestRender() {} },
    theme: {
      ...theme,
      bg: (_token: string, text: string) => {
        styledMatches.push(text);
        return `${MATCH_BG}${text}\x1b[49m`;
      },
    } as never,
    items: [{ text: "中文".repeat(10_000) }],
    done() {},
  });

  browser.handleInput("/");
  browser.handleInput("中");
  const row = browser.render(80).find((line) => line.includes(MATCH_BG)) ?? "";
  assert.ok(highlightedText(row).length > 0);
  assert.ok(styledMatches.length <= 40, `Styled ${styledMatches.length} matches for 80 columns`);
});

function makeBrowser(options: {
  items?: Array<{ text: string; timestamp?: string }>;
  loadWorkdirItems?: () => Promise<Array<{ text: string; timestamp?: string }>>;
  loadGlobalItems?: () => Promise<Array<{ text: string; timestamp?: string }>>;
  workdir?: string;
  results?: Array<string | null>;
  renders?: { count: number };
  copy?: (text: string) => void;
}) {
  return createPromptHistoryBrowserComponent({
    tui: {
      terminal: { columns: 80, rows: 24 },
      requestRender: () => {
        if (options.renders) options.renders.count += 1;
      },
    },
    theme: theme as never,
    items: options.items ?? [{ text: "SESSION-ONLY-ITEM" }],
    done: (result) => options.results?.push(result),
    ...(options.workdir ? { workdir: options.workdir } : {}),
    ...(options.loadWorkdirItems ? { loadWorkdirItems: options.loadWorkdirItems } : {}),
    ...(options.loadGlobalItems ? { loadGlobalItems: options.loadGlobalItems } : {}),
    ...(options.copy ? { copy: options.copy } : {}),
  });
}

test("c copies the selected prompt and closes without inserting", () => {
  const results: Array<string | null> = [];
  const copied: string[] = [];
  const browser = makeBrowser({
    items: [{ text: "HISTORY-ITEM-ALPHA" }, { text: "HISTORY-ITEM-BETA" }],
    results,
    copy: (text) => copied.push(text),
  });

  browser.handleInput("c");
  assert.deepEqual(copied, ["HISTORY-ITEM-BETA"]);
  assert.deepEqual(results, [null]);
});

test("c during search types into the query instead of copying", () => {
  const copied: string[] = [];
  const browser = makeBrowser({
    items: [{ text: "HISTORY-ITEM-ALPHA" }],
    copy: (text) => copied.push(text),
  });

  browser.handleInput("/");
  browser.handleInput("c");
  assert.deepEqual(copied, []);
  assert.match(browser.render(80).join("\n"), /Search: c/);
});

test("Ctrl+G cycles Session, Workdir, and Global scopes", async () => {
  const browser = makeBrowser({
    items: [{ text: "SESSION-ITEM" }],
    workdir: "/repo",
    loadWorkdirItems: async () => [{ text: "WORKDIR-ITEM" }],
    loadGlobalItems: async () => [{ text: "GLOBAL-ITEM" }],
  });

  assert.match(browser.render(80).join("\n"), /Prompt History — Session/);

  browser.handleInput(CTRL_G);
  await new Promise((resolve) => setImmediate(resolve));
  const workdir = browser.render(80).join("\n");
  assert.match(workdir, /Workdir: \/repo/);
  assert.match(workdir, /WORKDIR-ITEM/);

  browser.handleInput(CTRL_G);
  await new Promise((resolve) => setImmediate(resolve));
  const global = browser.render(80).join("\n");
  assert.match(global, /Prompt History — Global/);
  assert.match(global, /GLOBAL-ITEM/);

  browser.handleInput(CTRL_G);
  assert.match(browser.render(80).join("\n"), /Prompt History — Session/);
});

test("Ctrl+G swaps the list to global items and back, keeping the query", async () => {
  let resolveLoad: (items: Array<{ text: string; timestamp?: string }>) => void = () => undefined;
  const loaded = new Promise<Array<{ text: string; timestamp?: string }>>((resolve) => {
    resolveLoad = resolve;
  });
  const renders = { count: 0 };
  const browser = makeBrowser({
    items: [{ text: "SESSION-KEEP-ME" }],
    loadGlobalItems: () => loaded,
    renders,
  });

  browser.handleInput("/");
  for (const ch of "KEEP") browser.handleInput(ch);
  assert.match(browser.render(80).join("\n"), /Session \(1\)/);

  browser.handleInput(CTRL_G);
  // Load is in flight: placeholder instead of a stale or blocking list.
  const loading = browser.render(80).join("\n");
  assert.match(loading, /Global \(…\)/);
  assert.match(loading, /Loading global history/);
  assert.match(loading, /KEEP/, "query survives the scope switch");

  resolveLoad([{ text: "GLOBAL-KEEP-ME" }, { text: "GLOBAL-OTHER" }]);
  await loaded;
  await new Promise((resolve) => setImmediate(resolve));

  const global = browser.render(80).join("\n");
  assert.match(global, /Global \(2\)/);
  assert.match(global, /GLOBAL-KEEP-ME/);
  // The carried query still filters, so the non-matching global item is hidden.
  assert.doesNotMatch(global, /GLOBAL-OTHER/);
  assert.ok(renders.count > 0, "loading completion must request a render");

  browser.handleInput(CTRL_G);
  const back = browser.render(80).join("\n");
  assert.match(back, /Session \(1\)/);
  assert.match(back, /SESSION-KEEP-ME/);
});

test("Enter in global scope returns the global prompt text", async () => {
  const results: Array<string | null> = [];
  const browser = makeBrowser({
    loadGlobalItems: async () => [{ text: "GLOBAL-PICKED" }],
    results,
  });

  browser.handleInput(CTRL_G);
  await new Promise((resolve) => setImmediate(resolve));
  browser.handleInput("\r");

  assert.deepEqual(results, ["GLOBAL-PICKED"]);
});

test("global load failure is surfaced instead of showing an empty list", async () => {
  const browser = makeBrowser({
    loadGlobalItems: async () => {
      throw new Error("DISK-BOOM");
    },
  });

  browser.handleInput(CTRL_G);
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(browser.render(80).join("\n"), /DISK-BOOM/);
});

test("without a global loader Ctrl+G is inert", () => {
  const browser = makeBrowser({ items: [{ text: "SESSION-ONLY-ITEM" }] });

  browser.handleInput(CTRL_G);

  const rendered = browser.render(80).join("\n");
  assert.match(rendered, /Session \(1\)/);
  assert.match(rendered, /SESSION-ONLY-ITEM/);
});

test("a failed global load is retried on the next switch back", async () => {
  let attempts = 0;
  const browser = makeBrowser({
    loadGlobalItems: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("TRANSIENT-BOOM");
      return [{ text: "GLOBAL-AFTER-RETRY" }];
    },
  });

  browser.handleInput(CTRL_G);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(browser.render(80).join("\n"), /TRANSIENT-BOOM/);

  // Leave global and come back: the error must not be a dead end.
  browser.handleInput(CTRL_G);
  browser.handleInput(CTRL_G);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2);
  assert.match(browser.render(80).join("\n"), /GLOBAL-AFTER-RETRY/);
});

test("a load landing after close does not render into the torn-down browser", async () => {
  let resolveLoad: (items: Array<{ text: string; timestamp?: string }>) => void = () => undefined;
  const loaded = new Promise<Array<{ text: string; timestamp?: string }>>((resolve) => {
    resolveLoad = resolve;
  });
  const results: Array<string | null> = [];
  const renders = { count: 0 };
  const browser = makeBrowser({ loadGlobalItems: () => loaded, results, renders });

  browser.handleInput(CTRL_G);
  browser.handleInput("\x1b"); // close while the load is still in flight
  assert.deepEqual(results, [null]);

  const rendersAtClose = renders.count;
  resolveLoad([{ text: "LATE-ARRIVAL" }]);
  await loaded;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(renders.count, rendersAtClose, "late load must not request a render after close");
});

test("printable keys do not filter until / starts search", () => {
  const browser = makeBrowser({ items: [{ text: "SESSION-ONLY-ITEM" }] });

  for (const ch of "KEEP") browser.handleInput(ch);
  assert.match(browser.render(80).join("\n"), /SESSION-ONLY-ITEM/);
  assert.doesNotMatch(browser.render(80).join("\n"), /KEEP/);

  browser.handleInput("/");
  for (const ch of "KEEP") browser.handleInput(ch);
  assert.match(browser.render(80).join("\n"), /No matching prompts/);
  assert.match(browser.render(80).join("\n"), /KEEP/);
});

test("browse hides Search; / shows Search inside the box", () => {
  const browser = makeBrowser({ items: [{ text: "SESSION-ONLY-ITEM" }] });
  const browse = browser.render(80);
  assert.match(browse[0] ?? "", /^┌/);
  assert.match(browse.at(-1) ?? "", /┘$/);
  assert.equal(
    browse.some((line) => line.includes("Search:")),
    false,
  );

  browser.handleInput("/");
  for (const ch of "xyz") browser.handleInput(ch);
  const searching = browser.render(80);
  const searchLine = searching.find((line) => line.includes("Search: xyz"));
  assert.ok(searchLine);
  assert.match(searchLine, /^│/);
  assert.match(searchLine, /│$/);
});

test("j/k move like down/up and wrap", () => {
  const results: Array<string | null> = [];
  const browser = makeBrowser({
    items: [
      { text: "HISTORY-ITEM-ALPHA" },
      { text: "HISTORY-ITEM-BETA" },
      { text: "HISTORY-ITEM-GAMMA" },
    ],
    results,
  });

  // Newest-first: selected starts at GAMMA. k wraps to ALPHA.
  browser.handleInput("k");
  browser.handleInput("\r");
  assert.deepEqual(results, ["HISTORY-ITEM-ALPHA"]);

  const wrapResults: Array<string | null> = [];
  const browser2 = makeBrowser({
    items: [
      { text: "HISTORY-ITEM-ALPHA" },
      { text: "HISTORY-ITEM-BETA" },
      { text: "HISTORY-ITEM-GAMMA" },
    ],
    results: wrapResults,
  });

  // j twice reaches ALPHA, one more j wraps to GAMMA.
  browser2.handleInput("j");
  browser2.handleInput("j");
  browser2.handleInput("j");
  browser2.handleInput("\r");
  assert.deepEqual(wrapResults, ["HISTORY-ITEM-GAMMA"]);
});

test("g jumps to first item and G to last", () => {
  const first: Array<string | null> = [];
  const browser = makeBrowser({
    items: [
      { text: "HISTORY-ITEM-ALPHA" },
      { text: "HISTORY-ITEM-BETA" },
      { text: "HISTORY-ITEM-GAMMA" },
    ],
    results: first,
  });
  browser.handleInput("j");
  browser.handleInput("g");
  browser.handleInput("\r");
  assert.deepEqual(first, ["HISTORY-ITEM-GAMMA"]);

  const last: Array<string | null> = [];
  const browser2 = makeBrowser({
    items: [
      { text: "HISTORY-ITEM-ALPHA" },
      { text: "HISTORY-ITEM-BETA" },
      { text: "HISTORY-ITEM-GAMMA" },
    ],
    results: last,
  });
  browser2.handleInput("G");
  browser2.handleInput("\r");
  assert.deepEqual(last, ["HISTORY-ITEM-ALPHA"]);
});

test("q closes the browser", () => {
  const results: Array<string | null> = [];
  const browser = makeBrowser({ results });
  browser.handleInput("q");
  assert.deepEqual(results, [null]);
});

test("Esc from search clears the query and stays open", () => {
  const results: Array<string | null> = [];
  const browser = makeBrowser({
    items: [{ text: "SESSION-ONLY-ITEM" }],
    results,
  });
  browser.handleInput("/");
  for (const ch of "KEEP") browser.handleInput(ch);
  assert.match(browser.render(80).join("\n"), /No matching prompts/);

  browser.handleInput("\x1b");
  assert.deepEqual(results, []);
  assert.match(browser.render(80).join("\n"), /SESSION-ONLY-ITEM/);

  browser.handleInput("\x1b");
  assert.deepEqual(results, [null]);
});

test("Ctrl+D and Ctrl+U jump by half a page", () => {
  const results: Array<string | null> = [];
  const items = Array.from({ length: 20 }, (_, i) => ({
    text: `ITEM-${String(i).padStart(2, "0")}`,
  }));
  const browser = makeBrowser({ items, results });

  // rows=24, chrome=8 → maxVisible=14, half=7. Newest ITEM-19 at index 0.
  browser.handleInput("\x04");
  browser.handleInput("\r");
  assert.deepEqual(results, ["ITEM-12"]);

  const up: Array<string | null> = [];
  const browser2 = makeBrowser({ items, results: up });
  browser2.handleInput("G");
  browser2.handleInput("\x15");
  browser2.handleInput("\r");
  assert.deepEqual(up, ["ITEM-07"]);
});
