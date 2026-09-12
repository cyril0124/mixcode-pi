import assert from "node:assert/strict";
import { test } from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import {
  getCapabilities,
  getCellDimensions,
  Image,
  setCapabilities,
  setCellDimensions,
} from "@earendil-works/pi-tui";
import type { ChatLine, RuntimeTab } from "../src/agent/runtime-types.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { MixCodeRoot } from "../src/ui/app-layout.js";
import { Text, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { scrollChat } from "../src/core/overlays.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

// A real PNG with distinct horizontal bands makes source-rectangle checks meaningful.
const pixels = new Uint8Array(100 * 400 * 4);
for (let i = 0; i < pixels.length; i += 4) {
  pixels[i] = Math.floor(i / 400) < 200 ? 255 : 0;
  pixels[i + 2] = Math.floor(i / 400) < 200 ? 0 : 255;
  pixels[i + 3] = 255;
}
const bitmap = new PhotonImage(pixels, 100, 400);
const png = Buffer.from(bitmap.get_bytes()).toString("base64");
bitmap.free();

function captureTerminal(columns = 80, rows = 14) {
  const writes: string[] = [];
  const terminal: Terminal = {
    columns,
    rows,
    kittyProtocolActive: false,
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: (data) => {
      writes.push(data);
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
  return { terminal, writes };
}

test("fullscreen output preserves the chat crop before editor rows, including cached redraws", async () => {
  const caps = getCapabilities();
  const cells = getCellDimensions();
  setCapabilities({ ...caps, images: "kitty" });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
  const { terminal, writes } = captureTerminal();
  const tui = new TuiAltScreen(terminal);
  try {
    const state = createInitialState("/repo");
    const tab = createTab(1, "wire-image", "/repo", { chatScrollOffset: 1_000_000 });
    state.tabs.push(tab);
    state.activeTabId = tab.sessionId;
    const image = new Image(
      png,
      "image/png",
      { fallbackColor: (text) => text },
      { maxWidthCells: 40 },
    );
    const chat: ChatLine[] = [
      {
        role: "tool",
        title: "image",
        text: "",
        toolRenderShell: "self",
        renderToolCall: (width) => ["IMAGE TITLE", ...image.render(width), "AFTER IMAGE"],
      },
    ];
    const runtime = { getTab: () => ({ chat }) } as unknown as MixCodeRuntime;
    const root = new MixCodeRoot(
      state,
      runtime,
      () => terminal.rows,
      () => 3,
    );
    tui.addChild(root);
    tui.addChild(new Text("EDITOR\nDRAFT\nFOOTER", 0, 0));
    tui.start();
    await Bun.sleep(40);
    const transmissions = () => writes.join("").match(/\x1b_Ga=[Tp],[^\x1b]*/g) ?? [];
    assert.equal(transmissions().length, 1);
    assert.match(transmissions()[0]!, /(?:,|;)r=8(?:,|;)/);
    assert.match(transmissions()[0]!, /(?:,|;)h=160(?:,|;)/);
    assert.match(writes.join(""), /EDITOR/);

    writes.length = 0;
    scrollChat(tab, -5);
    tui.requestRender();
    await Bun.sleep(40);
    assert.equal(transmissions().length, 1);
    assert.match(transmissions()[0]!, /(?:,|;)r=9(?:,|;|$)/);
    assert.match(transmissions()[0]!, /(?:,|;)y=80(?:,|;)/);
    assert.match(transmissions()[0]!, /(?:,|;)h=180(?:,|;)/);
  } finally {
    tui.stop({ preserveScreen: true });
    setCapabilities(caps);
    setCellDimensions(cells);
  }
});

function imagePlacement(lines: string[]) {
  const row = lines.findIndex((line) => line.includes("\x1b_G"));
  assert.ok(row >= 0, "visible image portion must retain a graphics placement");
  const controls = /\x1b_G([^;]*);/.exec(lines[row]!);
  assert.ok(controls);
  const fields = Object.fromEntries(controls[1]!.split(",").map((field) => field.split("=")));
  return { row, y: Number(fields.y ?? 0), h: Number(fields.h ?? 400), rows: Number(fields.r) };
}

for (const mode of ["short", "windowed", "anchored"] as const) {
  for (const edge of ["top", "bottom", "both"] as const) {
    test(`${mode} chat clips an image at the ${edge} viewport edge`, () => {
      const caps = getCapabilities();
      const cells = getCellDimensions();
      setCapabilities({ ...caps, images: "kitty" });
      setCellDimensions({ widthPx: 10, heightPx: 20 });
      try {
        const image = new Image(
          png,
          "image/png",
          { fallbackColor: (text) => text },
          { maxWidthCells: 40 },
        );
        const imageLine: ChatLine = {
          role: "tool",
          title: "image",
          text: "",
          entryId: "image",
          toolRenderShell: "self",
          renderToolCall: (width) => ["IMAGE TITLE", ...image.render(width), "AFTER IMAGE"],
        };
        const history: ChatLine[] =
          mode === "windowed"
            ? Array.from({ length: 65 }, (_, i) => ({ role: "assistant", text: `history ${i}` }))
            : [];
        const chat = [...history, imageLine];
        const tab = createTab(1, `${mode}-${edge}`, "/repo");
        const runtime = { chat } as RuntimeTab;
        const width = 80;
        const height = 6;
        // The image is 20 rows tall: source pixels 0..400 at 20 pixels per row.
        // Relative to the image block: top=17 shows its last 4 rows, bottom=0
        // shows title + first 5 rows, both=5 shows 6 middle rows.
        const startInBlock = edge === "top" ? 17 : edge === "bottom" ? 0 : 5;
        if (mode === "anchored") {
          tab.chatScrollAnchorIndex = 0;
          tab.chatScrollAnchorEntryId = "image";
          tab.chatScrollOffset = -startInBlock;
        } else {
          tab.chatScrollOffset = Math.max(0, 22 - height - startInBlock);
        }
        const rendered = renderAgentSurface(tab, runtime, width, height);
        const placement = imagePlacement(rendered);
        const expected =
          edge === "top"
            ? // The bottom-pinned viewport clamps to block row 16 (22 - 6).
              { row: 0, y: 300, h: 100, rows: 5 }
            : edge === "bottom"
              ? { row: 1, y: 0, h: 100, rows: 5 }
              : { row: 0, y: 80, h: 120, rows: 6 };
        assert.deepEqual(placement, expected);
        assert.ok(
          placement.row + placement.rows <= height,
          "image must not cover the editor below chat",
        );
      } finally {
        setCapabilities(caps);
        setCellDimensions(cells);
      }
    });
  }
}
