// /console-history tab attribution. All tabs run in one process and share one
// console history, so each record stores the title of the tab whose work emitted
// it. These tests install the bridge globally (overriding console) and restore
// console in `finally`.

import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getConsoleHistory, installConsoleTuiBridge } from "../src/cli/console-tui-bridge.js";
import { currentConsoleTab, runWithConsoleTab } from "../src/core/console-scope.js";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  type MixCodeModel,
  createTab,
  mixcodeFauxStream,
} from "./helpers/mixcode.js";

// A non-"faux" provider so the runtime uses the test streamFn instead of its
// built-in faux provider (which would bypass the callback below).
const ATTRIBUTION_MODEL: MixCodeModel = {
  ...MIXCODE_FAUX_MODEL,
  provider: "console-attribution-test",
  api: "console-attribution-test",
  id: "console-attribution-test-1",
};

const HISTORY_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /;

function withoutStamp(lines: string[]): string[] {
  return lines.map((line) => line.replace(HISTORY_STAMP, ""));
}

function lastUserText(context: Context): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((block) => (block.type === "text" ? block.text : "[image]"))
      .join("");
  }
  return "";
}

function replaceConsoleForTest(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  return () => Object.assign(console, original);
}

test("console history labels tab-scoped lines and leaves unscoped lines as-is", () => {
  const restoreConsole = replaceConsoleForTest();
  try {
    installConsoleTuiBridge();
    // Work outside any tab (startup, extension timers) has no label.
    console.log("startup line");
    const label = runWithConsoleTab("Agent-01", () => {
      console.log("tab line");
      return currentConsoleTab();
    });

    assert.equal(label, "Agent-01");
    // The scope is gone once the callback returns.
    assert.equal(currentConsoleTab(), undefined);
    assert.deepEqual(withoutStamp(getConsoleHistory()), [
      "[console.log]: startup line",
      "[Agent-01] [console.log]: tab line",
    ]);
  } finally {
    restoreConsole();
  }
});

test("a tab's console label follows its turn through the agent loop without leaking to another tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-console-tab-"));
  const restoreConsole = replaceConsoleForTest();
  try {
    installConsoleTuiBridge();
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      // The provider stream sits deepest in the turn, behind the agent loop and
      // tool execution, so attributing it covers those paths too.
      streamFn: (model, context, options) => {
        console.log(`stream:${lastUserText(context)}`);
        return mixcodeFauxStream(model, context, options);
      },
    });
    for (const [index, sessionId] of [
      [1, "s1"],
      [2, "s2"],
    ] as const) {
      await runtime.createTab(createTab(index, sessionId, dir), {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: dir,
        model: ATTRIBUTION_MODEL,
      });
    }

    await Promise.all([runtime.prompt("s1", "first-tab"), runtime.prompt("s2", "second-tab")]);

    const lines = withoutStamp(getConsoleHistory());
    assert.ok(
      lines.includes("[Agent-01] [console.log]: stream:first-tab"),
      `missing first-tab attribution in:\n${lines.join("\n")}`,
    );
    assert.ok(
      lines.includes("[Agent-02] [console.log]: stream:second-tab"),
      `missing second-tab attribution in:\n${lines.join("\n")}`,
    );
  } finally {
    restoreConsole();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
