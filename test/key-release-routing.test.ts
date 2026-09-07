import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease } from "@earendil-works/pi-tui";
import { NullTerminal } from "../src/agent/runtime-null-terminal.js";
import { InjectingTerminal } from "../src/ui/terminal.js";
import { activateTab } from "../src/core/tabs.js";
import {
  createInitialState,
  createMixCodeTui,
  createTab,
  MixCodeRuntime,
} from "./helpers/mixcode.js";

const RELEASE_A = "\x1b[97;1:3u";
const RELEASE_UP = "\x1b[1;1:3A";
const RELEASE_ENTER = "\x1b[13;1:3u";
const RELEASE_ESCAPE = "\x1b[27;1:3u";
const RELEASE_CTRL_G = "\x1b[103;5:3u";
const RELEASE_TAB = "\x1b[9;1:3u";

type Mode = "embedded" | "overlay" | "editor";

async function withProbe(
  mode: Mode,
  subscribed: boolean,
  check: (probe: {
    input: (data: string) => void;
    received: string[];
    setSubscribed: (value: boolean) => void;
    focus: (sessionId: string) => void;
    listen: ExtensionUIContext["onTerminalInput"];
    state: ReturnType<typeof createInitialState>;
  }) => void | Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-key-release-"));
  const received: string[] = [];
  const ready = Promise.withResolvers<void>();
  let close: (() => void) | undefined;
  let subscribe = subscribed;
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("release-probe", {
      handler: async (_args, ctx) => {
        if (mode === "editor") {
          ctx.ui.setEditorComponent((tui, theme) => {
            return new (class extends Editor {
              get wantsKeyRelease() {
                return subscribe;
              }
              override render(width: number) {
                ready.resolve();
                return super.render(width);
              }
              override handleInput(data: string) {
                received.push(data);
                if (!isKeyRelease(data)) super.handleInput(data);
              }
            })(tui, theme);
          });
          close = () => ctx.ui.setEditorComponent(undefined);
          return;
        }
        await ctx.ui.custom(
          (_tui, _theme, _keys, done) => {
            close = () => done(undefined);
            return {
              get wantsKeyRelease() {
                return subscribe;
              },
              render: () => {
                ready.resolve();
                return ["release-probe"];
              },
              invalidate() {},
              handleInput: (data: string) => {
                received.push(data);
              },
            };
          },
          { overlay: mode === "overlay" },
        );
      },
    });
  };
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir: path.join(dir, "agent"),
    extensionFactories: [extension],
    resourceLoaderOptions: { noSkills: true, noContextFiles: true },
  });
  const state = createInitialState(dir);
  state.tabs = [createTab(1, "s1", dir), createTab(2, "s2", dir)];
  state.activeTabId = "s1";
  const terminal = new InjectingTerminal(new NullTerminal(100, 35));
  let tui: ReturnType<typeof createMixCodeTui> | undefined;
  let command: Promise<void> | undefined;
  try {
    for (const tab of state.tabs) {
      await runtime.createTab(tab, { systemPrompt: "system", thinkingLevel: "off", workdir: dir });
    }
    tui = createMixCodeTui(state, runtime, { terminal, exitProcessOnQuit: false });
    tui.start();
    command = runtime.prompt("s1", "/release-probe");
    await ready.promise;
    await check({
      input: (data) => terminal.inject(data),
      received,
      setSubscribed: (value) => {
        subscribe = value;
      },
      focus: (sessionId) => {
        activateTab(state, sessionId);
        tui!.renderNow();
      },
      listen: (handler) =>
        runtime.getTab("s1")!.agentSession.extensionRunner.getUIContext().onTerminalInput(handler),
      state,
    });
  } finally {
    close?.();
    await command;
    tui?.stop();
    await runtime.closeAllTabs();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const mode of ["embedded", "overlay", "editor"] as const) {
  test(`${mode} component receives opted-in releases unchanged without host actions`, async () => {
    await withProbe(mode, true, ({ input, received, state }) => {
      const releases = [
        RELEASE_A,
        RELEASE_UP,
        RELEASE_ENTER,
        RELEASE_ESCAPE,
        RELEASE_CTRL_G,
        RELEASE_TAB,
      ];
      input("a");
      for (const release of releases) input(release);
      input("v");
      assert.deepEqual(received, ["a", ...releases, "v"]);
      assert.equal(state.activeTabId, "s1");
      assert.equal(state.treeSelector.open, false);
      assert.equal(state.tabJumpOpen, false);
    });
  });

  test(`${mode} component can opt in and out of release delivery while focused`, async () => {
    await withProbe(mode, false, ({ input, received, setSubscribed }) => {
      input(RELEASE_A);
      setSubscribed(true);
      input(RELEASE_A);
      setSubscribed(false);
      input(RELEASE_A);
      input("v");
      assert.deepEqual(received, [RELEASE_A, "v"]);
    });
  });
}

test("release routing follows tab focus and never edits the other tab or Home", async () => {
  await withProbe("editor", true, ({ input, received, focus, state }) => {
    input(RELEASE_A);
    focus("s2");
    input(RELEASE_A);
    input(RELEASE_UP);
    input(RELEASE_TAB);
    assert.equal(state.activeTabId, "s2");
    assert.equal(state.tabs[1]!.draftInput, "");
    focus("home");
    input(RELEASE_A);
    input(RELEASE_TAB);
    assert.equal(state.activeTabId, "home");
    focus("s1");
    input(RELEASE_A);
    assert.deepEqual(received, [RELEASE_A, RELEASE_A]);
  });
});

test("terminal input listeners can consume or rewrite releases before an opted-in editor", async () => {
  await withProbe("editor", true, ({ input, received, listen }) => {
    const observed: string[] = [];
    const remove = listen((data) => {
      observed.push(data);
      if (data === RELEASE_A) return { consume: true };
      if (data === RELEASE_UP) return { data: RELEASE_ENTER };
      return undefined;
    });
    input(RELEASE_A);
    input(RELEASE_UP);
    remove();
    input(RELEASE_A);
    assert.deepEqual(observed, [RELEASE_A, RELEASE_UP]);
    assert.deepEqual(received, [RELEASE_ENTER, RELEASE_A]);
  });
});

test("a custom overlay stops receiving releases while its tab is hidden", async () => {
  await withProbe("overlay", true, ({ input, received, focus }) => {
    input(RELEASE_A);
    focus("s2");
    input(RELEASE_A);
    focus("s1");
    input(RELEASE_A);
    assert.deepEqual(received, [RELEASE_A, RELEASE_A]);
  });
});
