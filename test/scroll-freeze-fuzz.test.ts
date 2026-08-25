// Seeded property sweep over the scroll-freeze machinery. Each scenario
// randomly combines history size, markdown shape, chunk schedule, scroll
// timing/depth and end-of-run effects (object+text replacement, viewport
// growth). Invariant: between consecutive frames with no user scroll input,
// once the view is scrolled up (offset > 0), the top visible content line must
// stay byte-identical (after ANSI strip), because history is immutable and the
// streaming block only appends below the anchor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab, scrollChat, type ChatLine, type RuntimeTab } from "./helpers/mixcode.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

const WIDTH = 96;
const HEIGHT = 24;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHistory(rand: () => number): ChatLine[] {
  const count = 6 + Math.floor(rand() * 80);
  const chat: ChatLine[] = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 4;
    if (kind === 0) chat.push({ role: "assistant", text: `assistant-${i} ${"words ".repeat(1 + Math.floor(rand() * 12))}` });
    else if (kind === 1) chat.push({ role: "user", text: `user-${i}` });
    else if (kind === 2) chat.push({ role: "tool", title: "bash", toolCallId: `t-${i}`, status: "success", text: `out-${i}`, args: { command: `echo ${i}` } });
    else chat.push({ role: "system", text: `system-${i}` });
  }
  return chat;
}

function buildStreamingLines(rand: () => number): string[] {
  const lines: string[] = ["## streaming answer", ""];
  const total = 30 + Math.floor(rand() * 230);
  let fence = false;
  for (let i = 0; i < total; i++) {
    if (i > 4 && rand() < 0.03) {
      lines.push(fence ? "```" : "```ts");
      fence = !fence;
      continue;
    }
    if (rand() < 0.06) lines.push("");
    if (rand() < 0.05) lines.push(`- list item ${i} with some text`);
    else lines.push(`MD-${String(i).padStart(4, "0")} content words wrap ${i}`);
  }
  if (fence) lines.push("```");
  return lines;
}

function topContentLine(rendered: string[]): string | undefined {
  for (const line of rendered) {
    const text = stripAnsi(line).trim();
    if (!text) continue;
    if (text.startsWith("↑") || text.startsWith("↓")) continue;
    return text;
  }
  return undefined;
}

test("seeded scroll-freeze property sweep holds the top visible line", () => {
  // Budget: 80 seeds ran 46-61s on 2-core CI runners, flaking against the 60s
  // per-test timeout. 40 keeps the same leading deterministic seeds at 29s
  // local / ~38s projected on the slowest observed CI runner; set FZ_N higher
  // for deep local sweeps.
  const SCENARIOS = Number(process.env.FZ_N ?? 40);
  for (let scenario = 0; scenario < SCENARIOS; scenario++) {
    const rand = mulberry32(0x5c4011 + scenario * 7919);
    const chat = buildHistory(rand);
    const lines = buildStreamingLines(rand);
    const streamingIndex = chat.length;
    const visibleAtFreeze = 20 + Math.floor(rand() * 60);
    chat.push({ role: "assistant", text: lines.slice(0, visibleAtFreeze).join("\n") });

    const tab = createTab(scenario + 100, `fz${scenario}`, "/repo", {
      status: "running",
      chatScrollOffset: 0,
    });
    // streamingAssistant borrows the production type so it stays clearable when
    // the fuzz scenario ends the stream.
    const runtimeTab: { tab: typeof tab; chat: ChatLine[] } & Pick<RuntimeTab, "streamingAssistant"> = {
      tab,
      chat,
      streamingAssistant: {
        chatIndex: streamingIndex,
        blockIndices: new Map([[0, streamingIndex]]),
        toolCallIndices: new Map<string, number>(),
      },
    };
    const render = (height: number) => renderAgentSurface(tab, runtimeTab as never, WIDTH, height);

    render(HEIGHT); // bottom-pinned frame establishes baseline state
    let prevTop: string | undefined;
    let cursor = visibleAtFreeze;
    const frames = 14 + Math.floor(rand() * 16);
    let ended = false;
    let idleFrame = -1;

    for (let frame = 0; frame < frames; frame++) {
      let userActed = false;
      if (frame === 2 || (frame > 2 && rand() < 0.12)) {
        const delta = rand() < 0.85 ? 3 + Math.floor(rand() * 10) : -(1 + Math.floor(rand() * 5));
        scrollChat(tab, delta);
        userActed = true;
      }
      if (!ended && cursor < lines.length && rand() < 0.8) {
        cursor = Math.min(lines.length, cursor + 1 + Math.floor(rand() * 25));
        chat[streamingIndex] = { role: "assistant", text: lines.slice(0, cursor).join("\n") };
      }
      if (!ended && cursor >= lines.length && rand() < 0.5) {
        chat[streamingIndex] = {
          role: "assistant",
          text: `${lines.join("\n")}\nfinal marker line`,
        };
        runtimeTab.streamingAssistant = undefined;
        ended = true;
        idleFrame = frame + 1;
      }

      const height = idleFrame === frame ? HEIGHT + 1 : HEIGHT;
      const rendered = render(height).map(stripAnsi);
      const top = topContentLine(rendered);

      if (!userActed && prevTop !== undefined && tab.chatScrollOffset > 0) {
        assert.equal(
          top,
          prevTop,
          `scenario ${scenario} frame ${frame}: top line moved without user input (offset ${tab.chatScrollOffset})\n  before: ${prevTop}\n  after:  ${top}`,
        );
      }
      if (tab.chatScrollOffset > 0 && top !== undefined) prevTop = top;
      else prevTop = undefined;
    }
  }
});
