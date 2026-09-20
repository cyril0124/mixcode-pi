import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { MIXCODE_FAUX_MODEL, mixcodeFauxStream } from "../src/agent/faux-stream.js";
import type { MixCodeStreamFn } from "../src/agent/runtime-types.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { modelToRef } from "../src/core/models.js";
import { configureOpenTabsPath, readOpenTabs } from "../src/core/open-tabs-store.js";
import { loadStateFile, saveStateFile } from "../src/core/state-store.js";
import { HOME_TAB_ID, type MixCodeState } from "../src/core/types.js";
import { dispatchOwnedOverlayKey } from "../src/ui/app-key-handlers.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import { bindRuntimeRendering } from "../src/ui/app-runtime.js";
import { testTui } from "./helpers/tui.js";

interface Fixture {
  root: string;
  state: MixCodeState;
  runtime: MixCodeRuntime;
  stateFile: string;
  submit(text: string): Promise<void>;
}

async function withRuntime(
  run: (fixture: Fixture) => Promise<void>,
  extensions: ExtensionFactory[] = [],
  streamFn?: MixCodeStreamFn,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batch-command-"));
  const state = createInitialState(root);
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(root, "sessions"),
    agentDir: path.join(root, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    extensionFactories: extensions,
    streamFn,
  });
  const tui = testTui();
  const stateFile = path.join(root, "state.json");
  const unbind = bindRuntimeRendering(runtime, tui, state);
  configureOpenTabsPath(path.join(root, "open_tabs.json"));
  try {
    await run({
      root,
      state,
      runtime,
      stateFile,
      submit: (text) =>
        handleSubmittedInput(state, runtime, text, tui, (next) => saveStateFile(stateFile, next)),
    });
  } finally {
    unbind();
    await runtime.closeAllTabs();
    configureOpenTabsPath(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function userTexts(runtime: MixCodeRuntime, sessionId: string): string[] {
  return runtime
    .getTab(sessionId)!
    .agentSession.messages.filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
    );
}

const inspectScript = `export default api => api.openTab({ name: "result", prompt: JSON.stringify({ args: api.args(), cwd: api.currentWorkdir() }) });`;

test("/batch from empty Home preserves quoted paths, empty args, and literal shell text", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(path.join(root, "inspect  args.ts"), inspectScript);
    await submit(
      String.raw`/batch "inspect  args.ts" -- "two  spaces" '' "" 'single value' escaped\ value '$HOME' '$(touch marker)' '--flag' "a\"b" 'a\b'`,
    );
    assert.deepEqual(JSON.parse(userTexts(runtime, state.tabs[0]!.sessionId)[0]!), {
      args: [
        "two  spaces",
        "",
        "",
        "single value",
        "escaped value",
        "$HOME",
        "$(touch marker)",
        "--flag",
        'a"b',
        "a\\b",
      ],
      cwd: root,
    });
    assert.equal(await Bun.file(path.join(root, "marker")).exists(), false);
  });
});

for (const args of ["", "@", '"unfinished.ts', "run.ts extra", '""', "run.ts -- trailing\\"]) {
  test(`/batch rejects malformed arguments: ${JSON.stringify(args)}`, async () => {
    await withRuntime(async ({ state, submit, stateFile }) => {
      await assert.rejects(
        submit(`/batch ${args}`),
        /Error: (Usage: \/batch|Invalid batch arguments:)/,
      );
      assert.deepEqual(state.tabs, []);
      assert.equal(await Bun.file(stateFile).exists(), false);
    });
  });
}

test("/batch strips the file-autocomplete @ from the script but keeps it in script args", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(path.join(root, "inspect at.ts"), inspectScript);
    await submit(String.raw`/batch "@inspect at.ts" -- "@kept" @bare`);
    assert.deepEqual(JSON.parse(userTexts(runtime, state.tabs[0]!.sessionId)[0]!), {
      args: ["@kept", "@bare"],
      cwd: root,
    });
  });
});

test("/batch uses Agent workdir and Home instance workdir without process chdir", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    const cwd = process.cwd();
    await fs.mkdir(path.join(root, "package", "child"), { recursive: true });
    await Bun.write(
      path.join(root, "start.ts"),
      'export default api => api.openTab({name:"origin", workdir:"package"});',
    );
    await submit("/batch start.ts");
    await Bun.write(
      path.join(root, "package", "agent.ts"),
      `export default api => {
      api.openTab({name:"agent-default", prompt: api.currentWorkdir()});
      api.openTab({name:"agent-child", workdir:"child"});
    };`,
    );
    await submit("/batch agent.ts");
    assert.deepEqual(
      state.tabs.map((tab) => tab.workdir),
      [path.join(root, "package"), path.join(root, "package"), path.join(root, "package", "child")],
    );
    assert.deepEqual(userTexts(runtime, state.tabs[1]!.sessionId), [path.join(root, "package")]);
    state.activeTabId = HOME_TAB_ID;
    await Bun.write(path.join(root, "home.ts"), inspectScript);
    await handleSubmittedInput(
      state,
      runtime,
      "/batch home.ts",
      testTui(),
      undefined,
      undefined,
      undefined,
      state.tabs[2],
    );
    assert.equal(state.tabs[3]!.workdir, root);
    assert.equal(process.cwd(), cwd);
  });
});

test("/batch reports the script directory separately from the invocation workdir", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await fs.mkdir(path.join(root, "package"), { recursive: true });
    await Bun.write(
      path.join(root, "package", "probe.ts"),
      `export default api =>
        api.openTab({ name: "probe", prompt: api.scriptDir() + "|" + api.currentWorkdir() });`,
    );
    await submit("/batch package/probe.ts");
    const tab = state.tabs.find((item) => item.title === "probe")!;
    assert.equal(userTexts(runtime, tab.sessionId)[0], `${path.join(root, "package")}|${root}`);
  });
});

for (const extension of ["ts", "lua"]) {
  test(`/batch ${extension} clear retains identity and history; delete replaces it`, async () => {
    await withRuntime(async ({ root, state, runtime, submit, stateFile }) => {
      await Bun.write(
        path.join(root, "start.ts"),
        'export default api => api.openTab({name:"target", prompt:"old task", systemPrompt:"Original identity"});',
      );
      await submit("/batch start.ts");
      const tab = state.tabs[0]!;
      const id = tab.sessionId;
      const original = runtime.getTab(id)!;
      const file = original.agentSession.sessionFile!;
      const oldEntries = original.session.getEntries();
      const reset =
        extension === "ts"
          ? 'export default api => api.openTab({name:"target", mode:"clear"});'
          : 'mixcode.open_tab({name="target", mode="clear"})';
      await Bun.write(path.join(root, `reset.${extension}`), reset);
      await submit(`/batch reset.${extension}`);
      assert.equal(tab.sessionId, id);
      assert.equal(original.agentSession.sessionFile, file);
      assert.equal(state.activeTabId, id);
      assert.equal(tab.title, "target");
      assert.deepEqual(original.session.getEntries(), oldEntries);
      assert.deepEqual(userTexts(runtime, id), []);
      assert.match(original.agentSession.systemPrompt, /Original identity/);
      assert.deepEqual(readOpenTabs(path.join(root, "open_tabs.json")), [id]);
      assert.deepEqual(
        (await loadStateFile(stateFile, root)).tabs.map((item) => item.sessionId),
        [id],
      );
      const invalid =
        extension === "ts"
          ? 'export default api => api.openTab({name:"target", mode:"clear", systemPrompt:""});'
          : 'mixcode.open_tab({name="target", mode="clear", system_prompt=""})';
      await Bun.write(path.join(root, `invalid.${extension}`), invalid);
      await assert.rejects(
        submit(`/batch invalid.${extension}`),
        /Error:.*system_prompt.*mode="clear"/,
      );
      assert.deepEqual(original.session.getEntries(), oldEntries);
      const replace =
        extension === "ts"
          ? 'export default api => api.openTab({name:"target", mode:"delete", prompt:"new task"});'
          : 'mixcode.open_tab({name="target", mode="delete", prompt="new task"})';
      await Bun.write(path.join(root, `replace.${extension}`), replace);
      await submit(`/batch replace.${extension}`);
      const replacement = state.tabs[0]!;
      assert.notEqual(replacement.sessionId, id);
      assert.equal(runtime.getTab(id), undefined);
      assert.equal(await Bun.file(file).exists(), false);
      assert.deepEqual(userTexts(runtime, replacement.sessionId), ["new task"]);
      assert.deepEqual(
        (await loadStateFile(stateFile, root)).tabs.map((item) => item.sessionId),
        [replacement.sessionId],
      );
    });
  });
}

test("/batch captures fresh tab/model snapshots on each invocation while retaining TS module state", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    state.availableModels.push(
      ...["alpha", "preferred"].map((provider) => ({
        ...state.model,
        provider,
        modelId: "shared",
        displayName: `${provider}/shared`,
      })),
    );
    state.model = { ...state.model, provider: "preferred" };
    await Bun.write(
      path.join(root, "snapshot.ts"),
      `let calls = 0; export default api => api.openTab({ name:"snapshot", model:"faux/faux-1", prompt:JSON.stringify({ calls:++calls, exists:api.tabExists("snapshot"), model:api.resolveModel("shared") }) });`,
    );
    await submit("/batch snapshot.ts");
    const id = state.tabs[0]!.sessionId;
    state.availableModels.find((model) => model.provider === "preferred")!.disabled = true;
    await submit("/batch snapshot.ts");
    assert.deepEqual(
      state.tabs.map((tab) => tab.sessionId),
      [id],
    );
    assert.deepEqual(
      userTexts(runtime, id).map((text) => JSON.parse(text)),
      [
        { calls: 1, exists: false, model: "preferred/shared" },
        { calls: 2, exists: true, model: "alpha/shared" },
      ],
    );
    state.availableModels.find((model) => model.provider === "alpha")!.disabled = true;
    await assert.rejects(
      submit("/batch snapshot.ts"),
      /Error:.*No available model matches: shared/,
    );
  });
});

for (const extension of ["ts", "lua"]) {
  test(`/batch ${extension} single prompts execute local commands on their owning tab`, async () => {
    await withRuntime(async ({ root, state, runtime, submit }) => {
      await Bun.write(
        path.join(root, "setup.ts"),
        'export default api => { api.openTab({name:"owner"}); api.openTab({name:"other"}); };',
      );
      await submit("/batch setup.ts");
      const owner = state.tabs.find((tab) => tab.title === "owner")!;
      const other = state.tabs.find((tab) => tab.title === "other")!;
      const source =
        extension === "ts"
          ? 'export default api => { api.openTab({name:"owner", prompt:"/color red"}); api.openTab({name:"owner", prompt:"after color"}); };'
          : 'mixcode.open_tab({name="owner", prompt="/color red"}); mixcode.open_tab({name="owner", prompt="after color"})';
      await Bun.write(path.join(root, `local.${extension}`), source);
      await submit(`/batch local.${extension}`);
      assert.equal(owner.color, "red");
      assert.equal(other.color, undefined);
      assert.equal(state.activeTabId, other.sessionId);
      assert.deepEqual(userTexts(runtime, owner.sessionId), ["after color"]);
      assert.deepEqual(userTexts(runtime, other.sessionId), []);
    });
  });
}

test("/batch single local command waits for confirmation and cancellation stops its group", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(
      path.join(root, "setup.ts"),
      'export default api => api.openTab({name:"owner"});',
    );
    await submit("/batch setup.ts");
    const owner = state.tabs[0]!;
    await Bun.write(
      path.join(root, "confirm.ts"),
      'export default api => { api.openTab({name:"owner", prompt:"/close-session"}); api.openTab({name:"owner", prompt:"must not run"}); };',
    );
    const running = submit("/batch confirm.ts");
    const rejected = assert.rejects(running, /Error: Queued command cancelled/);
    // File loading and persistence precede the dialog; observe the actual confirmation state.
    for (let attempt = 0; attempt < 100 && !state.sessionActionConfirm; attempt++)
      await Bun.sleep(10);
    assert.deepEqual(state.sessionActionConfirm, { action: "close", sessionId: owner.sessionId });
    assert.deepEqual(userTexts(runtime, owner.sessionId), []);
    dispatchOwnedOverlayKey(state, owner, "n", testTui(), runtime);
    await rejected;
    assert.equal(state.tabs.includes(owner), true);
    assert.deepEqual(userTexts(runtime, owner.sessionId), []);
  });
});

test("/batch preserves unknown slash text and shell input through nested batch commands", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(
      path.join(root, "route.ts"),
      `export default api => {
      api.openTab({name:"routes", prompt:"/unknown first\\n  second"});
      api.openTab({name:"routes", prompt:"/tmp/a path"});
      api.openTab({name:"routes", prompt:"!printf batch-shell"});
    };`,
    );
    await submit("/batch route.ts");
    const id = state.tabs[0]!.sessionId;
    assert.deepEqual(userTexts(runtime, id), ["/unknown first\n  second", "/tmp/a path"]);
    const shell = runtime
      .getTab(id)!
      .agentSession.messages.find((message) => message.role === "bashExecution");
    assert.ok(shell && "output" in shell);
    assert.equal(shell.output, "batch-shell");
    await Bun.write(
      path.join(root, "nested.ts"),
      'export default api => api.openTab({name:"routes", prompt:"/batch route.ts"});',
    );
    await submit("/batch nested.ts");
    assert.deepEqual(userTexts(runtime, id), [
      "/unknown first\n  second",
      "/tmp/a path",
      "/unknown first\n  second",
      "/tmp/a path",
    ]);
  });
});

test("nested /batch uses its target workdir while focus stays on Home", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    const nestedWorkdir = path.join(root, "nested-workdir");
    await fs.mkdir(nestedWorkdir);
    await Bun.write(
      path.join(root, "setup.ts"),
      'export default api => api.openTab({name:"owner", workdir:"nested-workdir"});',
    );
    await submit("/batch setup.ts");
    const owner = state.tabs[0]!;
    await Bun.write(
      path.join(nestedWorkdir, "inner.lua"),
      'mixcode.open_tab({name="owner", prompt="/color red"})',
    );
    await Bun.write(
      path.join(root, "outer.ts"),
      'export default api => api.openTab({name:"owner", prompt:"/batch inner.lua"});',
    );
    state.activeTabId = HOME_TAB_ID;
    await submit("/batch outer.ts");
    assert.equal(owner.color, "red");
    assert.equal(state.activeTabId, HOME_TAB_ID);
    assert.deepEqual(userTexts(runtime, owner.sessionId), []);
  });
});

test("/batch queues complete sequences across tabs without waiting for their execution", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const entered: string[] = [];
  await withRuntime(
    async ({ root, state, runtime, submit, stateFile }) => {
      const finished = Promise.withResolvers<void>();
      const off = runtime.onChange((event) => {
        if (event.type !== "agent_settled") return;
        if (
          ["one", "two"].every((name) => {
            const tab = state.tabs.find((tab) => tab.title === name);
            return tab && userTexts(runtime, tab.sessionId).at(-1) === `${name} done`;
          })
        )
          finished.resolve();
      });
      try {
        await Bun.write(
          path.join(root, "sequence.ts"),
          `export default api => {
          for (const name of ["one", "two"]) {
            api.openTab({name, prompts: ["/hold-sequence " + name, name + " done"]});
          }
        };`,
        );
        await submit("/batch sequence.ts");
        await started.promise;
        assert.deepEqual(entered.toSorted(), ["one", "two"]);
        for (const tab of state.tabs) {
          assert.deepEqual(tab.pendingFollowUps, [`${tab.title} done`]);
          assert.deepEqual(tab.pendingMessages, []);
          assert.deepEqual(userTexts(runtime, tab.sessionId), []);
        }
        assert.deepEqual(
          (await loadStateFile(stateFile, root)).tabs.map((tab) => tab.title),
          ["one", "two"],
        );
        release.resolve();
        await finished.promise;
        for (const tab of state.tabs) {
          assert.deepEqual(userTexts(runtime, tab.sessionId), [`${tab.title} done`]);
        }
      } finally {
        release.resolve();
        off();
      }
    },
    [
      (pi) =>
        pi.registerCommand("hold-sequence", {
          handler: async (args) => {
            entered.push(args);
            if (entered.length === 2) started.resolve();
            await release.promise;
          },
        }),
    ],
  );
});

for (const extension of ["ts", "lua"]) {
  test(`/batch ${extension} rejects a later invalid sequence before any tab mutation`, async () => {
    await withRuntime(async ({ root, state, runtime, submit }) => {
      await Bun.write(
        path.join(root, "create.ts"),
        'export default api => api.openTab({name:"keep", prompt:"history"});',
      );
      await submit("/batch create.ts");
      const sessionId = state.tabs[0]!.sessionId;
      const source =
        extension === "ts"
          ? 'export default api => { api.openTab({name:"new"}); api.openTab({name:"keep", mode:"delete", prompts:["valid", "!echo invalid"]}); };'
          : 'mixcode.open_tab({name="new"}); mixcode.open_tab({name="keep", mode="delete", prompts={"valid", "!echo invalid"}})';
      await Bun.write(path.join(root, `invalid.${extension}`), source);
      await assert.rejects(submit(`/batch invalid.${extension}`), /Error:.*prompts.*keep/);
      assert.deepEqual(
        state.tabs.map((tab) => tab.sessionId),
        [sessionId],
      );
      assert.deepEqual(userTexts(runtime, sessionId), ["history"]);
    });
  });
}

test("/batch skips empty strings without adding user or command rounds", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(
      path.join(root, "create.ts"),
      'export default api => api.openTab({name:"sequence"});',
    );
    await submit("/batch create.ts");
    const tab = state.tabs[0]!;
    tab.followUpsPaused = true;
    await Bun.write(
      path.join(root, "blanks.ts"),
      'export default api => api.openTab({name:"sequence", prompts:["", "first", "  ", "/color blue", "", "second", ""]});',
    );
    await submit("/batch blanks.ts");
    assert.deepEqual(tab.pendingFollowUps, ["first", "/color blue", "second"]);
    await runtime.resumeFollowUps(tab.sessionId);
    assert.deepEqual(userTexts(runtime, tab.sessionId), ["first", "second"]);
    assert.equal(tab.color, "blue");
  });
});

test("/batch sequences execute local commands on their owning tab between prompt rounds", async () => {
  const colors: Array<string | undefined> = [];
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(
      path.join(root, "setup.ts"),
      'export default api => { api.openTab({name:"owner"}); api.openTab({name:"other"}); };',
    );
    await submit("/batch setup.ts");
    const owner = state.tabs.find((tab) => tab.title === "owner")!;
    const other = state.tabs.find((tab) => tab.title === "other")!;
    owner.followUpsPaused = true;
    await Bun.write(
      path.join(root, "commands.ts"),
      `export default api => api.openTab({
      name:"owner", prompts:["/color red", "first", "/color blue", "second"]
    });`,
    );
    const off = runtime.onChange((event) => {
      if (event.type === "agent_start") colors.push(owner.color);
    });
    try {
      await submit("/batch commands.ts");
      assert.deepEqual(owner.pendingFollowUps, ["/color red", "first", "/color blue", "second"]);
      assert.equal(owner.color, undefined);
      assert.equal(state.activeTabId, other.sessionId);
      await runtime.resumeFollowUps(owner.sessionId);
      assert.deepEqual(colors, ["red", "blue"]);
      assert.deepEqual(userTexts(runtime, owner.sessionId), ["first", "second"]);
      assert.equal(owner.color, "blue");
      assert.equal(other.color, undefined);
      assert.equal(state.activeTabId, other.sessionId);
    } finally {
      off();
    }
  });
});

test("/batch queued command cancellation pauses remaining work and resume consumes it once", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(
      path.join(root, "setup.ts"),
      'export default api => api.openTab({name:"owner"});',
    );
    await submit("/batch setup.ts");
    const tab = state.tabs[0]!;
    tab.followUpsPaused = true;
    await Bun.write(
      path.join(root, "confirm.lua"),
      'mixcode.open_tab({name="owner", prompts={"/close-session", "/color blue", "after"}})',
    );
    await submit("/batch confirm.lua");
    const resumed = assert.rejects(
      runtime.resumeFollowUps(tab.sessionId),
      /Error: Queued command cancelled/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(state.sessionActionConfirm, { action: "close", sessionId: tab.sessionId });
    assert.equal(tab.color, undefined);
    assert.deepEqual(tab.pendingFollowUps, ["/color blue", "after"]);
    dispatchOwnedOverlayKey(state, tab, "n", testTui(), runtime);
    await resumed;
    assert.equal(tab.followUpsPaused, true);
    assert.equal(state.tabs.includes(tab), true);
    await runtime.resumeFollowUps(tab.sessionId);
    assert.equal(tab.color, "blue");
    assert.deepEqual(userTexts(runtime, tab.sessionId), ["after"]);
  });
});

test("/batch command failures pause the sequence before the following prompt", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(
      path.join(root, "setup.ts"),
      'export default api => api.openTab({name:"owner"});',
    );
    await submit("/batch setup.ts");
    const tab = state.tabs[0]!;
    tab.followUpsPaused = true;
    await Bun.write(
      path.join(root, "failure.ts"),
      'export default api => api.openTab({name:"owner", prompts:["/models missing-model-for-batch", "after"]});',
    );
    await submit("/batch failure.ts");
    await assert.rejects(runtime.resumeFollowUps(tab.sessionId), /Error:.*Unknown model/);
    assert.equal(tab.followUpsPaused, true);
    assert.deepEqual(tab.pendingFollowUps, ["after"]);
    assert.deepEqual(userTexts(runtime, tab.sessionId), []);
    await runtime.resumeFollowUps(tab.sessionId);
    assert.deepEqual(userTexts(runtime, tab.sessionId), ["after"]);
  });
});

test("/batch appends arrays to paused tabs without resuming or steering", async () => {
  await withRuntime(async ({ root, state, runtime, submit }) => {
    await Bun.write(
      path.join(root, "paused.ts"),
      'export default api => api.openTab({name:"paused"});',
    );
    await submit("/batch paused.ts");
    const tab = state.tabs[0]!;
    tab.followUpsPaused = true;
    await runtime.prompt(tab.sessionId, "earlier", { streamingBehavior: "followUp" });
    await Bun.write(
      path.join(root, "queue.lua"),
      'mixcode.open_tab({name="paused", prompts={"first", "second"}})',
    );
    await submit("/batch queue.lua");
    assert.deepEqual(tab.pendingFollowUps, ["earlier", "first", "second"]);
    assert.deepEqual(tab.pendingMessages, []);
    assert.deepEqual(userTexts(runtime, tab.sessionId), []);
    assert.equal(tab.followUpsPaused, true);
    await submit("/follow-up-next");
    assert.deepEqual(userTexts(runtime, tab.sessionId), ["earlier", "first", "second"]);
  });
});

test("/batch persists mutations before dispatch and after one parallel group fails", async () => {
  const observed = Promise.withResolvers<void>();
  let stateFile = "";
  let savedTitles: string[] | undefined;
  await withRuntime(
    async ({ root, state, submit, stateFile: file }) => {
      stateFile = file;
      await Bun.write(
        path.join(root, "partial.ts"),
        `export default api => {
      api.openTab({name:"saved", prompt:"/inspect-saved"});
      api.openTab({name:"failure", prompt:"/models missing-batch-model"});
    };`,
      );
      await assert.rejects(
        submit("/batch partial.ts"),
        /Error:.*Unknown model: missing-batch-model/,
      );
      await observed.promise;
      assert.deepEqual(savedTitles, ["saved", "failure"]);
      assert.deepEqual(
        (await loadStateFile(stateFile, root)).tabs.map((tab) => tab.title),
        ["saved", "failure"],
      );
      await Bun.write(path.join(root, "empty.ts"), "export default () => {};");
      await submit("/batch empty.ts");
      assert.deepEqual(
        state.tabs.map((tab) => tab.title),
        ["saved", "failure"],
      );
    },
    [
      (pi) => {
        pi.registerCommand("inspect-saved", {
          handler: async () => {
            try {
              savedTitles = (await loadStateFile(stateFile, "")).tabs.map((tab) => tab.title);
            } finally {
              observed.resolve();
            }
          },
        });
      },
    ],
  );
});

test("/batch appends to a streaming tab as steering and rejects clear without erasing its view", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  await withRuntime(
    async ({ root, state, runtime, submit }) => {
      const model = { ...MIXCODE_FAUX_MODEL, provider: "batch-blocked", api: "batch-blocked" };
      const tab = createTab(1, "busy-session", root, { title: "busy", model: modelToRef(model) });
      state.tabs.push(tab);
      state.activeTabId = tab.sessionId;
      await runtime.createTab(tab, { workdir: root, model });
      const running = runtime.prompt(tab.sessionId, "initial task");
      try {
        await entered.promise;
        await Bun.write(
          path.join(root, "append.ts"),
          'export default api => api.openTab({name:"busy", prompt:"steer task"});',
        );
        await submit("/batch append.ts");
        assert.deepEqual(runtime.getTab(tab.sessionId)!.agentSession.getSteeringMessages(), [
          "steer task",
        ]);
        tab.chatScrollOffset = 7;
        tab.chatScrollAnchorText = "visible task";
        await Bun.write(
          path.join(root, "clear.ts"),
          'export default api => api.openTab({name:"busy", mode:"clear"});',
        );
        await assert.rejects(
          submit("/batch clear.ts"),
          /Error: Cannot reset a session while it is streaming/,
        );
        assert.equal(tab.chatScrollOffset, 7);
        assert.equal(tab.chatScrollAnchorText, "visible task");
      } finally {
        release.resolve();
        await running;
      }
      assert.deepEqual(userTexts(runtime, tab.sessionId), ["initial task", "steer task"]);
    },
    [],
    async (model, context, options) => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return mixcodeFauxStream(model, context, options);
    },
  );
});

for (const scenario of ["dispatch", "configure", "validation"] as const) {
  test(`/batch retains ${scenario} errors when saving also fails`, async () => {
    await withRuntime(async ({ root, state, runtime, submit }) => {
      await Bun.write(
        path.join(root, "create.ts"),
        'export default api => api.openTab({name:"target"});',
      );
      await submit("/batch create.ts");
      const blocked = path.join(root, "blocked");
      await Bun.write(blocked, "not a directory");
      const unregistered = {
        ...state.model,
        provider: "absent",
        modelId: "absent",
        displayName: "absent/absent",
      };
      if (scenario === "configure") state.availableModels.push(unregistered);
      const options =
        scenario === "dispatch"
          ? { name: "target", prompt: "/models missing-batch-model" }
          : { name: "target", model: "absent/absent" };
      const file = path.join(root, `${scenario}.ts`);
      await Bun.write(file, `export default api => api.openTab(${JSON.stringify(options)});`);
      const expected =
        scenario === "dispatch"
          ? "Unknown model: missing-batch-model"
          : scenario === "configure"
            ? "Model is not registered in runtime: absent/absent"
            : "Unknown model";
      await assert.rejects(
        handleSubmittedInput(state, runtime, `/batch ${file}`, testTui(), () =>
          saveStateFile(path.join(blocked, "state.json"), state),
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /^Error:/);
          assert.ok(error.message.includes(expected), error.message);
          assert.match(error.message, /ENOTDIR/);
          assert.ok(error.cause instanceof AggregateError);
          return true;
        },
      );
      // A rejected save must not prevent a later invocation from persisting.
      await submit("/batch create.ts");
    });
  });
}

test("/batch surfaces a save-only failure without manufacturing an execution error", async () => {
  await withRuntime(async ({ root, state, runtime }) => {
    const file = path.join(root, "empty.ts");
    const blocked = path.join(root, "blocked");
    await Bun.write(file, "export default () => {};");
    await Bun.write(blocked, "not a directory");
    await assert.rejects(
      handleSubmittedInput(state, runtime, `/batch ${file}`, testTui(), () =>
        saveStateFile(path.join(blocked, "state.json"), state),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Error:.*ENOTDIR/);
        assert.equal(error.cause instanceof AggregateError, false);
        return true;
      },
    );
  });
});

test("/batch rejects missing scripts, invalid models, and loading targets before creating tabs", async () => {
  await withRuntime(async ({ root, state, submit }) => {
    await assert.rejects(submit("/batch missing.ts"), /Error:.*missing.ts/);
    await Bun.write(
      path.join(root, "invalid.ts"),
      'export default api => {api.openTab({name:"untouched"}); api.openTab({name:"invalid", model:"missing/model"});};',
    );
    await assert.rejects(submit("/batch invalid.ts"), /Error:.*Unknown model/);
    assert.equal(state.tabs.length, 0);
    await Bun.write(
      path.join(root, "create.ts"),
      'export default api => api.openTab({name:"loading"});',
    );
    await submit("/batch create.ts");
    state.tabs[0]!.status = "Not Ready";
    await assert.rejects(submit("/batch create.ts"), /Error: Batch tab is still loading: loading/);
    assert.equal(state.tabs[0]!.status, "Not Ready");
  });
});
