import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createTab,
  padLine,
  renderChat,
  renderInputMeta,
  renderWorkingIndicator,
} from "./helpers/mixcode.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("padLine strips control sequences, expands tabs, and fits width", () => {
  assert.equal(padLine("\x01ok\x02", 6), "ok    ");
  assert.match(padLine("\x1bPpayload\x1b\\ok", 6), /ok/);
  const tabbed = padLine("file.ts:1:\t\tthis.ui.invalidate();", 40);
  assert.equal(tabbed.includes("\t"), false);
  assert.equal(visibleWidth(tabbed), 40);
});

test("tool chat lines stay within width and drop clear-screen controls", () => {
  const cleared = renderChat(
    [
      {
        role: "tool",
        title: "bash",
        status: "success",
        args: { command: "\x1b[2J\x1b[Hprintf ok" },
        text: "\x1b]0;title\x07ok\x1b_Gbad\x07",
      },
    ],
    40,
  ).join("\n");
  assert.equal(cleared.includes("\x1b[2J"), false);
  assert.match(stripAnsi(cleared), /ok/);

  const toolBlock = renderChat(
    [
      {
        role: "tool",
        title: "bash",
        status: "success",
        args: { command: "cat package.json" },
        text: '{\n  "name": "mixcode-pi"\n}',
      },
    ],
    48,
  );
  assert.equal(toolBlock.every((line) => visibleWidth(line) === 48), true);
});

test("custom tool renderers receive content width; self shell skips paint frame", () => {
  const widths: number[] = [];
  const custom = renderChat(
    [
      {
        role: "tool",
        title: "custom",
        status: "success",
        text: "fallback",
        renderToolCall: (width) => {
          widths.push(width);
          return ["call one"];
        },
        renderToolResult: (width) => {
          widths.push(width);
          return ["result one"];
        },
      },
    ],
    24,
  );
  assert.deepEqual(widths, [22, 22]);
  assert.match(stripAnsi(custom.join("\n")), /call one[\s\S]*result one/);

  const self = stripAnsi(
    renderChat(
      [
        {
          role: "tool",
          title: "self-rendered",
          status: "success",
          text: "fallback",
          toolRenderShell: "self",
          renderToolCall: () => ["self call"],
          renderToolResult: () => ["self result"],
        },
      ],
      24,
    ).join("\n"),
  );
  assert.match(self, /self call/);
  assert.match(self, /self result/);
});

test("error system messages show error text without a System label", () => {
  const error = stripAnsi(
    renderChat([{ role: "system", text: "Error: 503 Service Unavailable" }], 60).join("\n"),
  );
  assert.match(error, /Error: 503 Service Unavailable/);
  assert.doesNotMatch(error, /\[System\]:/);

  const plain = stripAnsi(renderChat([{ role: "system", text: "Just a note" }], 60).join("\n"));
  assert.match(plain, /Just a note/);
  assert.doesNotMatch(plain, /\[System\]:/);
});

test("system markdown tables render as visible table text", () => {
  const plain = stripAnsi(
    renderChat(
      [
        {
          role: "system",
          text: ["**Hotkeys**", "", "| Key | Action |", "|-----|--------|", "| `/` | Slash commands |"].join(
            "\n",
          ),
        },
      ],
      60,
    ).join("\n"),
  );
  assert.match(plain, /Hotkeys/);
  assert.match(plain, /Key/);
  assert.match(plain, /Slash commands/);
  assert.doesNotMatch(plain, /\|-----\|--------\|/);
});

test("narrow input meta stays width-bounded and keeps a models hit region", () => {
  const tab = createTab(1, "s1", "/repo/" + "long/".repeat(8), {
    pendingMessages: ["queued"],
    pendingEscapeArmedAt: 1_700_000_000_000,
  });
  const line = renderInputMeta(tab, 28).join("\n");
  assert.equal(visibleWidth(line), 27);
  const actions = tab.inputMetaHitRegions.map((region) => region.action);
  assert.ok(actions.includes("models"));
  // Non-strict layout may still paint a compacted workdir when ≥4 cols remain.
  assert.ok(actions.every((action) => action === "models" || action === "workdir"));
});

test("blank custom working message still shows Working duration", () => {
  const plain = stripAnsi(
    renderWorkingIndicator(
      createTab(1, "s1", "/repo", {
        status: "running",
        extensionUi: {
          statuses: [],
          widgets: [],
          toolsExpanded: false,
          workingVisible: true,
          workingMessage: "   ",
        },
      }),
      80,
      new Date("2026-05-10T00:00:00.000Z"),
    ).join("\n"),
  );
  assert.match(plain, /Working \(0s/);
});
