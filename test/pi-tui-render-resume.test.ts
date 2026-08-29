import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Text, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";

// Contract (patched pi-tui): after a stop()/start() renderer handoff, plain
// requestRender() must still schedule a repaint. Upstream 0.84.4 leaves
// `renderRequested` dangling when a render was requested but not yet consumed
// at stop() time; start()'s own requestRender() then no-ops forever and every
// interval-driven animation redraw (tab shimmer, loading spinner) is dead
// until a keypress heals it via requestImmediateRender().

function recordingTerminal(writes: string[]): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: (data: string) => {
      writes.push(data);
    },
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearToEndOfScreen: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  } as unknown as Terminal;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("requestRender still repaints after a stop()/start() handoff", async () => {
  const writes: string[] = [];
  const tui = new TuiMainScreen(recordingTerminal(writes));
  tui.start();
  tui.addChild(new Text("before-handoff"));
  tui.requestRender();
  await settle();
  assert.ok(writes.length > 0, "baseline render must write to the terminal");

  // Dangle window: a render is requested, then stop() lands in the same tick.
  // The pending nextTick scheduleRender() sees `stopped` and bails, leaving
  // renderRequested=true with nothing left to consume it.
  tui.requestRender();
  tui.stop();
  await settle();

  tui.start();
  writes.length = 0;
  // Model the animation redraw interval: content changed, plain request.
  tui.addChild(new Text("after-handoff"));
  tui.requestRender();
  await settle();
  assert.ok(
    writes.some((data) => data.includes("after-handoff")),
    "post-start requestRender must repaint (renderRequested dangled across stop/start)",
  );
});
