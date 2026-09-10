import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { stopChatSelectionAutoScroll } from "../../src/ui/app-mouse.js";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createInitialState,
  createMixCodeTui,
  createTab,
  scrollChat,
} from "./mixcode.js";

const dir = process.argv[2];
if (!dir) throw new Error("A temporary directory is required");
const longStreaming = process.argv[3] === "long";
const homeNavigation = process.argv[3] === "home";
const state = createInitialState(dir);
state.tabs = Array.from({ length: 6 }, (_, index) =>
  createTab(index + 1, `cursor-${index}`, dir, { title: `terminal-cursor-example-tab-${index}` }),
);
const tab = state.tabs.at(-1)!;
state.activeTabId = tab.sessionId;
const runtime = new MixCodeRuntime({ agentDir: dir, sessionsRoot: path.join(dir, "sessions") });
const runtimeTab = await runtime.createTab(tab, {
  systemPrompt: "Terminal rendering test",
  thinkingLevel: "off",
  workdir: dir,
  model: MIXCODE_FAUX_MODEL,
});
runtimeTab.chat = [
  ...(longStreaming
    ? Array.from({ length: 64 }, (_, row) => ({ role: "user" as const, text: `history-${row}` }))
    : []),
  {
    role: "assistant",
    text: Array.from(
      { length: longStreaming ? 400 : 100 },
      (_, row) => `ROW-${row} 中文 text${longStreaming ? ` ${"content ".repeat(8)}` : ""}`,
    ).join("\n"),
  },
];
if (process.argv[3] === "prompt-zones") {
  runtimeTab.chat = [
    { role: "thinking", text: "Let me write." },
    {
      role: "assistant",
      text: '**依据主要在 `IHI0050H` 的 3 个地方（按贴合度排序），另外要明确一点：CHI 没有"MakeInvalid 前必须先发 Evict"这种要求，这是个合法但非必需的 stimulus。**',
    },
  ];
}
if (homeNavigation) {
  runtimeTab.chat = Array.from({ length: 100 }, (_, block) => ({
    role: "assistant",
    text: Array.from({ length: 20 }, (_, row) => `ROW-${block}-${row}`).join("\n"),
  }));
  tab.vimMode = true;
}
if (longStreaming) {
  tab.status = "running";
  const chatIndex = runtimeTab.chat.length - 1;
  runtimeTab.streamingAssistant = {
    chatIndex,
    blockIndices: new Map([[0, chatIndex]]),
    toolCallIndices: new Map(),
  };
}
tab.startupSummary = undefined;
tab.startupSummaryCompact = undefined;
tab.chatScrollOffset = 10;

class ScenarioTerminal extends ProcessTerminal {
  private output = "";

  override write(data: string): void {
    this.output += data;
    super.write(data);
  }

  takeOutput(): string {
    const output = this.output;
    this.output = "";
    return output;
  }

  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start((data) => {
      if (homeNavigation && ["g", "j", "k"].includes(data)) {
        onInput(data);
        if (data !== "g" || !tab.vimPendingHome) {
          tui.renderNow();
          void saveFrame(data === "g" ? "home" : data === "j" ? "down" : "up");
        }
        return;
      }
      if (data === "p") {
        stopChatSelectionAutoScroll();
        tui.renderNow();
        void saveFrame("dragged");
        return;
      }
      if (data === "t" || data === "g") {
        if (data === "t") {
          tab.chatScrollOffset = 0;
        } else {
          runtimeTab.chat.at(-1)!.text +=
            "\n" + Array.from({ length: 10 }, (_, row) => `ADDED-${row} 中文 text`).join("\n");
        }
        tui.renderNow();
        void saveFrame(data === "t" ? "tail" : "grown");
        return;
      }
      if (data === "q") {
        tui.stop({ preserveScreen: true });
        void saveFrame("stopped");
        void Bun.sleep(10_000);
        return;
      }
      if (data === "s") {
        tui.stop({ preserveScreen: true });
        tui.start();
        process.stdout.write("\x1b[2J\x1b[H");
        tui.renderNow();
        void saveFrame("restarted");
        return;
      }
      const phase = new Map([
        ["d", "shifted"],
        ["m", "margins"],
        ["o", "origin"],
        ["f", "full-redraw"],
      ]).get(data);
      if (!phase) {
        onInput(data);
        return;
      }
      // A scrolling margin can survive a terminal handoff. Painting across it
      // moves existing cells even though the renderer's line cache is unchanged.
      if (data !== "d") {
        process.stdout.write(data === "o" ? "\x1b[4;27r\x1b[?6h" : "\x1b[1;27r");
        scrollChat(tab, 1);
        tui.injectInput("x");
        tui.renderNow(data === "f");
        const jump = tab.chatJumpToLatestHitRegion!;
        const bounds = tab.chatSurfaceBounds!;
        tui.injectInput(`\x1b[<35;${jump.column + 2};${bounds.top + jump.row}M`);
        tui.renderNow();
      } else {
        process.stdout.write("\x1b[2B");
        tab.title = "terminal-cursor-example-tab-x";
        scrollChat(tab, 1);
        tui.renderNow();
      }
      void saveFrame(phase);
    }, onResize);
  }
}
const terminal = new ScenarioTerminal();
const tui = createMixCodeTui(state, runtime, { terminal });
async function saveFrame(phase: string): Promise<void> {
  const file = path.join(dir!, "frame.json");
  await Bun.write(
    `${file}.tmp`,
    JSON.stringify({
      phase,
      lines: phase === "stopped" ? [] : tui.render(tui.terminal.columns),
      bounds: tab.chatSurfaceBounds,
      scrollOffset: tab.chatScrollOffset,
      terminalOutput: terminal.takeOutput(),
    }),
  );
  await fs.rename(`${file}.tmp`, file);
}
process.stdout.write("PARENT-SCREEN-SENTINEL");
tui.start();
tui.renderNow(true);
await saveFrame("baseline");
