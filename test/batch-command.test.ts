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

for (const args of ["", '"unfinished.ts', "run.ts extra", '""', "run.ts -- trailing\\"]) {
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

test("/batch preserves unknown slash text and shell input while refusing nested local commands", async () => {
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
    await assert.rejects(
      submit("/batch nested.ts"),
      /Error:.*Batch prompt cannot execute.*\/batch/,
    );
    assert.deepEqual(userTexts(runtime, id), ["/unknown first\n  second", "/tmp/a path"]);
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
      api.openTab({name:"failure", prompt:"/settings"});
    };`,
      );
      await assert.rejects(
        submit("/batch partial.ts"),
        /Error:.*Batch prompt cannot execute.*\/settings/,
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
          ? { name: "target", prompt: "/batch nested.ts" }
          : { name: "target", model: "absent/absent" };
      const file = path.join(root, `${scenario}.ts`);
      await Bun.write(file, `export default api => api.openTab(${JSON.stringify(options)});`);
      const expected =
        scenario === "dispatch"
          ? "Batch prompt cannot execute MixCode local command: /batch"
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
