import assert from "node:assert/strict";
import { test } from "node:test";
import { registerStuckGuardCommand } from "./config-command.js";
import { StuckGuardStats } from "./stats.js";

function makeHarness() {
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let rendered = "";
  const pi = {
    registerCommand(
      _name: string,
      definition: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      command = definition;
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify() {},
      async custom(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: () => void,
        ) => { render(width: number): string[] },
        _options: unknown,
      ) {
        const component = factory(
          {},
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          () => {},
        );
        rendered = component.render(100).join("\n");
      },
    },
  };
  return {
    pi,
    ctx,
    get command() {
      return command;
    },
    get rendered() {
      return rendered;
    },
  };
}

test("stats command opens a current-session counter view", async () => {
  const stats = new StuckGuardStats();
  stats.recordProviderState("idle");
  stats.recordProviderTimeout("start");
  const harness = makeHarness();
  registerStuckGuardCommand(harness.pi as never, stats);
  await harness.command!.handler("stats", harness.ctx);
  assert.match(harness.rendered, /Stuck Guard Stats/);
  assert.match(harness.rendered, /Provider attempts: 1/);
  assert.match(harness.rendered, /Start timeouts: 1/);
  assert.match(harness.rendered, /Current session only/);
});
