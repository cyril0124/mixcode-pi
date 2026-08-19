import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createTab,
  renderAgentSurface,
  renderInputMeta,
  renderQueuePreview,
} from "./helpers/mixcode.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("queue preview shows count, shortcuts, and latest messages", () => {
  const one = stripAnsi(
    renderAgentSurface(
      createTab(1, "s1", "/repo", { pendingMessages: ["first queued message"] }),
      { chat: [] } as never,
      80,
    ).join("\n"),
  );
  assert.match(one, /Steer \(1\)/);
  assert.match(one, /Esc->send now {2}Ctrl\+U->edit/);
  assert.match(one, /first queued message/);

  const multi = stripAnsi(
    renderQueuePreview(
      createTab(2, "s2", "/repo", { pendingMessages: ["1", "2", "3", "4", "5", "6"] }),
      80,
    ).join("\n"),
  );
  assert.match(multi, /Steer \(6, latest 5\)/);
  assert.doesNotMatch(multi, /↳ 1/);
  assert.match(multi, /↳ 6/);

  const dual = stripAnsi(
    renderQueuePreview(
      createTab(3, "s3", "/repo", {
        pendingMessages: ["steer me"],
        pendingFollowUps: ["after done"],
      }),
      80,
    ).join("\n"),
  );
  assert.match(dual, /Steer \(1\)/);
  assert.match(dual, /Follow-up \(1\)/);
  assert.match(dual, /steer me/);
  assert.match(dual, /after done/);
  assert.match(dual, /Esc->send now/);
  // Follow-up box must not advertise Esc->send now.
  const followBlock = dual.slice(dual.indexOf("Follow-up"));
  assert.doesNotMatch(followBlock, /Esc->send now/);
});

test("agent surface does not invent thinking when rebuilt chat has none", () => {
  const surface = stripAnsi(
    renderAgentSurface(
      createTab(1, "s1", "/repo"),
      { chat: [{ role: "user", text: "hello again" }] } as never,
      80,
    ).join("\n"),
  );
  assert.match(surface, /hello again/);
  assert.doesNotMatch(surface, /thinking|thought|Pondering|Analyzing/i);
});

test("agent surface shows thinking content only once", () => {
  const surface = stripAnsi(
    renderAgentSurface(
      createTab(1, "s1", "/repo"),
      {
        chat: [
          { role: "thinking", text: "same thought" },
          { role: "assistant", text: "done" },
        ],
      } as never,
      100,
    ).join("\n"),
  );
  assert.equal((surface.match(/same thought/g) ?? []).length, 1);
});

test("pending escape arm no longer paints Esc-again stop in input meta", () => {
  const tab = createTab(1, "s1", "/repo", {
    pendingEscapeArmedAt: Date.now(),
  });
  // Arm feedback is toast-only (see handleEscapeKey); meta stays free of chord hints.
  assert.doesNotMatch(stripAnsi(renderInputMeta(tab, 100).join("\n")), /Esc again: stop/);
});

test("extension-rendered tool lines with tabs stay within terminal width", () => {
  const width = 136;
  const lines = renderAgentSurface(
    createTab(1, "s1", "/repo"),
    {
      chat: [
        {
          role: "tool",
          title: "grep",
          text: "",
          status: "success",
          renderToolResult: () => [
            `path.lua:11: \t${"MakeReadUnique = 0x01 + lshift(1, 6),".repeat(8)}`,
          ],
        },
      ],
    } as never,
    width,
  );
  assert.equal(lines.every((line) => visibleWidth(line) <= width), true);
});
