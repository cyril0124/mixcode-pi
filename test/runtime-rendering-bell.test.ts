import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { createTab } from "../src/core/defaults.js";
import type { MixCodeTabInfo } from "../src/core/types.js";
import { bindRuntimeRendering } from "../src/ui/app.js";

/** Terminal stub that records every escape sequence the bell path emits. */
function recordingTerminal(writes: string[]): Terminal {
  return {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    write: (data: string) => {
      writes.push(data);
    },
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

test("runtime rendering rings terminal bell when a tab completes work", () => {
  let listener:
    | ((
        event: { type: string; errorMessage?: string },
        runtimeTab: { tab: MixCodeTabInfo },
      ) => void)
    | undefined;
  let renders = 0;
  const writes: string[] = [];
  const active = createTab(1, "s1", "/repo", { status: "running" });
  const compacted = createTab(2, "s2", "/repo", { status: "idle", unreadDone: true });
  const refreshOnly = createTab(3, "s3", "/repo", { status: "idle", unreadDone: true });
  const tui = {
    terminal: recordingTerminal(writes),
    requestRender: () => {
      renders++;
    },
  };
  const unsubscribe = bindRuntimeRendering(
    {
      onChange: (nextListener) => {
        listener = nextListener as typeof listener;
        return () => {
          listener = undefined;
        };
      },
    },
    tui,
  );

  active.status = "idle";
  active.unreadDone = true;
  listener?.({ type: "agent_end" }, { tab: active });
  listener?.({ type: "extension_ui_update" }, { tab: active });
  listener?.({ type: "compaction_end" }, { tab: compacted });
  listener?.({ type: "extension_ui_update" }, { tab: refreshOnly });
  listener?.({ type: "compaction_end", errorMessage: "failed" }, { tab: refreshOnly });

  assert.deepEqual(writes, ["\x07", "\x07"]);
  assert.equal(renders, 5);
  unsubscribe();
});

test("runtime rendering rings terminal bell when a new user interaction appears", () => {
  let listener:
    | ((event: { type: string }, runtimeTab: { tab: MixCodeTabInfo }) => void)
    | undefined;
  const writes: string[] = [];
  const tab = createTab(1, "s1", "/repo", { status: "running" });
  const tui = {
    terminal: recordingTerminal(writes),
    requestRender: () => {},
  };
  const unsubscribe = bindRuntimeRendering(
    {
      onChange: (nextListener) => {
        listener = nextListener as typeof listener;
        return () => {
          listener = undefined;
        };
      },
    },
    tui,
  );

  tab.extensionUi.waitingForInputs.push({ id: "q1", kind: "custom" });
  listener?.({ type: "extension_ui_update" }, { tab });
  assert.deepEqual(writes, ["\x07"], "bell should ring for new waiting-for-input");

  // Same count — no additional bell
  listener?.({ type: "extension_ui_update" }, { tab });
  assert.deepEqual(writes, ["\x07"], "no extra bell when count unchanged");

  // Simulate a new waitingForInput appearing
  tab.extensionUi.waitingForInputs.push({ id: "ext-1", kind: "custom" });
  listener?.({ type: "extension_ui_update" }, { tab });
  assert.deepEqual(writes, ["\x07", "\x07"], "bell should ring for new waitingForInput");

  unsubscribe();
});
