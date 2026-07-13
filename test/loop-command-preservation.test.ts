import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab } from "../src/core/defaults.js";
import { submitAgentInput } from "../src/ui/agent-tab-actions.js";
import type { MixCodeSubmitRuntime } from "../src/ui/app-types.js";

const MULTILINE_COMMAND = "/loop 10m first line\nsecond line\nthird line";

test("MixCode forwards multiline extension commands without rebuilding whitespace", async () => {
  const forwarded: string[] = [];
  const runtime = {
    prompt: async (_sessionId: string, text: string) => {
      forwarded.push(text);
    },
    getExtensionCommands: () => [{ name: "loop" }],
  } as unknown as MixCodeSubmitRuntime;

  const handled = await submitAgentInput(
    createTab(1, "session-1", "/tmp"),
    runtime,
    MULTILINE_COMMAND,
  );

  assert.equal(handled, true);
  assert.deepEqual(forwarded, [MULTILINE_COMMAND]);
});
