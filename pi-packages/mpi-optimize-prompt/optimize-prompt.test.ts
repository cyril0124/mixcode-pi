import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  loadOptimizePromptConfig,
  parseOptimizePromptConfig,
  parseOptimizePromptConfigText,
  writeOptimizePromptConfig,
} from "./config.js";
import { createOptimizePromptConfigOverlay } from "./config-overlay.js";
import {
  extractOptimizedText,
  formatOptimizePromptHelp,
  resolveOptimizeSource,
  resolveOptimizeSystemPrompt,
  resolveOptimizeTarget,
  DEFAULT_OPTIMIZE_SYSTEM_PROMPT,
} from "./core.js";
import optimizePrompt, {
  cancelOptimize,
  runOptimizePrompt,
  runOptimizePromptConfig,
  type OptimizeAbortSlot,
} from "./index.js";

describe("mpi-optimize-prompt core", () => {
  it("resolveOptimizeSource prefers args over editor draft", () => {
    assert.equal(resolveOptimizeSource(" from args ", "from editor"), "from args");
    assert.equal(resolveOptimizeSource("  ", "  draft  "), "draft");
    assert.equal(resolveOptimizeSource("", ""), "");
  });

  it("resolveOptimizeTarget inherits session unless config overrides", () => {
    const active = { provider: "a", modelId: "m1", thinkingLevel: "medium" };
    assert.deepEqual(resolveOptimizeTarget(active), active);
    assert.deepEqual(resolveOptimizeTarget(active, { model: "inherit", thinking: "inherit" }), active);
    assert.deepEqual(resolveOptimizeTarget(active, { model: "b/m2", thinking: "high" }), {
      provider: "b",
      modelId: "m2",
      thinkingLevel: "high",
    });
    assert.deepEqual(resolveOptimizeTarget(active, { model: "bad" }), active);
  });

  it("resolveOptimizeSystemPrompt uses custom or default", () => {
    assert.equal(resolveOptimizeSystemPrompt(), DEFAULT_OPTIMIZE_SYSTEM_PROMPT);
    assert.equal(resolveOptimizeSystemPrompt({ systemPrompt: "  custom  " }), "custom");
  });

  it("formatOptimizePromptHelp documents config path and fields", () => {
    const help = formatOptimizePromptHelp("/tmp/agent/optimize-prompt.json");
    assert.match(help, /\/opt-prompt help/);
    assert.match(help, /\/opt-prompt config/);
    assert.match(help, /\/opt-prompt-cancel/);
    assert.match(help, /overlay/i);
    assert.match(help, /\/tmp\/agent\/optimize-prompt\.json/);
    assert.match(help, /systemPrompt/);
    assert.match(help, /inherit active session model/);
  });

  it("extractOptimizedText returns text and rejects failures", () => {
    assert.equal(
      extractOptimizedText({
        content: [{ type: "text", text: " improved " }],
        stopReason: "stop",
      }),
      "improved",
    );
    assert.throws(
      () => extractOptimizedText({ content: [{ type: "text", text: "" }], stopReason: "stop" }),
      /empty text/,
    );
    assert.throws(
      () =>
        extractOptimizedText({
          content: [{ type: "text", text: "x" }],
          stopReason: "error",
          errorMessage: "boom",
        }),
      /boom/,
    );
  });
});

describe("mpi-optimize-prompt config", () => {
  it("parseOptimizePromptConfig keeps non-empty fields only", () => {
    assert.deepEqual(parseOptimizePromptConfig(null), {});
    assert.deepEqual(
      parseOptimizePromptConfig({
        model: " openai/gpt ",
        thinking: " low ",
        systemPrompt: " rewrite ",
        extra: 1,
      }),
      {
        model: "openai/gpt",
        thinking: "low",
        systemPrompt: "rewrite",
      },
    );
  });

  it("loadOptimizePromptConfig reads file or missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-config-"));
    try {
      const missing = loadOptimizePromptConfig(dir);
      assert.equal(missing.ok, true);
      if (missing.ok) {
        assert.equal(missing.missing, true);
        assert.deepEqual(missing.config, {});
      }

      await fs.writeFile(
        path.join(dir, "optimize-prompt.json"),
        JSON.stringify({ model: "x/y", thinking: "high", systemPrompt: "S" }),
        "utf8",
      );
      const loaded = loadOptimizePromptConfig(dir);
      assert.equal(loaded.ok, true);
      if (loaded.ok) {
        assert.deepEqual(loaded.config, {
          model: "x/y",
          thinking: "high",
          systemPrompt: "S",
        });
      }

      await fs.writeFile(path.join(dir, "optimize-prompt.json"), "{", "utf8");
      const bad = loadOptimizePromptConfig(dir);
      assert.equal(bad.ok, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writeOptimizePromptConfig persists and parseOptimizePromptConfigText validates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-write-"));
    try {
      const written = writeOptimizePromptConfig(dir, { model: "a/b", thinking: "low" });
      assert.equal(written.ok, true);
      const loaded = loadOptimizePromptConfig(dir);
      assert.equal(loaded.ok, true);
      if (loaded.ok) assert.deepEqual(loaded.config, { model: "a/b", thinking: "low" });

      assert.deepEqual(parseOptimizePromptConfigText(""), { ok: true, config: {} });
      assert.equal(parseOptimizePromptConfigText("{not json").ok, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mpi-optimize-prompt command", () => {
  it("registers opt-prompt and opt-prompt-cancel commands plus markdown panel", () => {
    const names: string[] = [];
    const renderers: string[] = [];
    optimizePrompt({
      registerCommand: (name: string) => {
        names.push(name);
      },
      registerEntryRenderer: (type: string) => {
        renderers.push(type);
      },
      getThinkingLevel: () => "medium",
    } as never);
    assert.deepEqual(names, ["opt-prompt", "opt-prompt-cancel"]);
    assert.deepEqual(renderers, ["mpi-optimize-prompt-panel"]);
  });

  it("rewrites editor via completeSimple with live aboveEditor progress widget", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-run-"));
    try {
      let editor = "fix the flaky test";
      const widgetPayloads: unknown[] = [];
      const notifies: Array<{ message: string; type?: string }> = [];
      const completeCalls: Array<{
        systemPrompt?: string;
        user: string;
        reasoning?: string;
        provider: string;
        modelId: string;
      }> = [];

      const ctx = {
        model: { provider: "tab", id: "main" },
        modelRegistry: {
          find: (provider: string, modelId: string) => ({ provider, id: modelId }),
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
        },
        ui: {
          getEditorText: () => editor,
          setEditorText: (text: string) => {
            editor = text;
          },
          setWidget: (
            _key: string,
            content:
              | string[]
              | undefined
              | ((
                  tui: { requestRender: () => void },
                  theme: { fg: (c: string, t: string) => string; bold?: (t: string) => string },
                ) => { render: () => string[]; dispose?: () => void }),
          ) => {
            widgetPayloads.push(content);
            if (typeof content === "function") {
              const component = content(
                { requestRender: () => undefined },
                {
                  fg: (c: string, t: string) => `[${c}]${t}`,
                  bold: (t: string) => t,
                },
              );
              const lines = component.render().join("\n");
              assert.match(lines, /Optimizing prompt/);
              assert.match(lines, /tab\/main/);
              assert.match(lines, /think:high/);
              assert.match(lines, /\d+ chars/);
              assert.match(lines, /\/opt-prompt-cancel/);
              assert.doesNotMatch(lines, /\[dim\]/);
              component.dispose?.();
            }
          },
          notify: (message: string, type?: string) => {
            notifies.push({ message, type });
          },
        },
      } as unknown as ExtensionCommandContext;

      const result = await runOptimizePrompt({
        ctx,
        args: "",
        getThinkingLevel: () => "high",
        agentDir: dir,
        complete: async (model, context, options) => {
          completeCalls.push({
            provider: (model as { provider: string }).provider,
            modelId: (model as { id: string }).id,
            systemPrompt: context.systemPrompt,
            user: String(
              Array.isArray(context.messages[0]?.content)
                ? (context.messages[0]?.content as Array<{ text?: string }>)[0]?.text
                : context.messages[0]?.content,
            ),
            reasoning: options?.reasoning,
          });
          return {
            content: [{ type: "text", text: "Fix the flaky test in test/foo.test.ts" }],
            stopReason: "stop",
          } as never;
        },
      });

      assert.equal(result.ok, true);
      assert.equal(editor, "Fix the flaky test in test/foo.test.ts");
      assert.equal(completeCalls.length, 1);
      assert.equal(completeCalls[0]?.provider, "tab");
      assert.equal(completeCalls[0]?.modelId, "main");
      assert.equal(completeCalls[0]?.reasoning, "high");
      assert.equal(completeCalls[0]?.user, "fix the flaky test");
      assert.match(completeCalls[0]?.systemPrompt ?? "", /rewritten prompt/i);
      assert.equal(typeof widgetPayloads[0], "function");
      assert.equal(widgetPayloads.at(-1), undefined);
      assert.equal(notifies.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses config model/thinking/systemPrompt overrides", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-cfg-run-"));
    try {
      await fs.writeFile(
        path.join(dir, "optimize-prompt.json"),
        JSON.stringify({
          model: "override/cheap",
          thinking: "low",
          systemPrompt: "CUSTOM SYSTEM",
        }),
        "utf8",
      );
      let editor = "draft";
      const completeCalls: Array<{ provider: string; modelId: string; reasoning?: string; system?: string }> =
        [];
      const ctx = {
        model: { provider: "tab", id: "main" },
        modelRegistry: {
          find: (provider: string, modelId: string) => ({ provider, id: modelId }),
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
        },
        ui: {
          getEditorText: () => editor,
          setEditorText: (text: string) => {
            editor = text;
          },
          setWidget: () => undefined,
          notify: () => undefined,
        },
      } as unknown as ExtensionCommandContext;

      await runOptimizePrompt({
        ctx,
        args: "",
        getThinkingLevel: () => "high",
        agentDir: dir,
        complete: async (model, context, options) => {
          completeCalls.push({
            provider: (model as { provider: string }).provider,
            modelId: (model as { id: string }).id,
            reasoning: options?.reasoning,
            system: context.systemPrompt,
          });
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
          } as never;
        },
      });

      assert.deepEqual(completeCalls, [
        { provider: "override", modelId: "cheap", reasoning: "low", system: "CUSTOM SYSTEM" },
      ]);
      assert.equal(editor, "ok");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("config overlay applies model/thinking immediately and can request prompt editor", () => {
    const results: unknown[] = [];
    const changes: unknown[] = [];
    const theme = {
      fg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    const view = createOptimizePromptConfigOverlay({
      theme,
      requestRender: () => undefined,
      done: (result) => {
        results.push(result);
      },
      onChange: (config) => {
        changes.push({ ...config });
      },
      initial: {},
      modelOptions: ["a/m1", "b/m2"],
      thinkingOptions: ["inherit", "low", "high"],
    });

    const main = view.render(60).join("\n");
    assert.match(main, /┌.*Optimize Prompt Config/);
    assert.match(main, /Changes apply immediately/);
    assert.doesNotMatch(main, /\bSave\b/);

    // Model row is first; enter picker, arrow to b/m2.
    view.handleInput("\r");
    assert.match(view.render(60).join("\n"), /Select model/);
    view.handleInput("\x1b[B"); // inherit -> a/m1
    view.handleInput("\x1b[B"); // a/m1 -> b/m2
    view.handleInput("\r");
    assert.match(view.render(60).join("\n"), /b\/m2/);
    assert.deepEqual(changes.at(-1), { model: "b/m2" });

    // Thinking row: inherit, low, high -> pick high.
    view.handleInput("\x1b[B"); // down to thinking
    view.handleInput("\r");
    assert.match(view.render(60).join("\n"), /Select thinking/);
    view.handleInput("\x1b[B"); // inherit -> low
    view.handleInput("\x1b[B"); // low -> high
    view.handleInput("\r");
    assert.deepEqual(changes.at(-1), { model: "b/m2", thinking: "high" });

    // System prompt -> edit-prompt action.
    view.handleInput("\x1b[B");
    view.handleInput("e");
    assert.deepEqual(results.at(-1), {
      action: "edit-prompt",
      config: { model: "b/m2", thinking: "high" },
    });
  });

  it("config subcommand persists on change and on system-prompt editor", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-config-cmd-"));
    try {
      const notifies: string[] = [];
      let editorOpened = 0;
      let customCalls = 0;

      const driveOverlay = (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (result: unknown) => void,
        ) => { handleInput(data: string): void },
        script: "pick-and-close" | "edit-then-close",
      ) =>
        new Promise((resolve) => {
          customCalls += 1;
          const view = factory(
            { requestRender: () => undefined, terminal: { rows: 40, columns: 80 } },
            { fg: (_c: string, t: string) => t, bold: (t: string) => t },
            {},
            (result) => resolve(result),
          );
          if (script === "pick-and-close" || customCalls > 1) {
            view.handleInput("\r"); // model picker
            view.handleInput("\x1b[B"); // first non-inherit
            view.handleInput("\r");
            view.handleInput("\x1b[B"); // thinking
            view.handleInput("\r");
            view.handleInput("\x1b[B"); // off
            view.handleInput("\x1b[B"); // minimal
            view.handleInput("\x1b[B"); // low
            view.handleInput("\r");
            view.handleInput("\x1b"); // Esc close
            return;
          }
          // First open in edit-then-close: system prompt + e.
          view.handleInput("\x1b[B");
          view.handleInput("\x1b[B");
          view.handleInput("e");
        });

      const ctx = {
        model: { provider: "tab", id: "main" },
        modelRegistry: {
          getAvailable: () => [{ provider: "ov", id: "cheap" }],
        },
        ui: {
          custom: async (factory: never) => driveOverlay(factory, "pick-and-close"),
          editor: async () => {
            editorOpened += 1;
            return "CUSTOM PROMPT";
          },
          notify: (message: string) => {
            notifies.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;

      const result = await runOptimizePromptConfig({ ctx, agentDir: dir });
      assert.equal(result.ok, true);
      assert.equal(editorOpened, 0);
      const loaded = loadOptimizePromptConfig(dir);
      assert.equal(loaded.ok, true);
      if (loaded.ok) {
        assert.ok(loaded.config.model === "ov/cheap" || loaded.config.model === "tab/main");
        assert.equal(loaded.config.thinking, "low");
      }

      customCalls = 0;
      const editCtx = {
        model: { provider: "tab", id: "main" },
        modelRegistry: { getAvailable: () => [] },
        ui: {
          custom: async (factory: never) => driveOverlay(factory, "edit-then-close"),
          editor: async (_title: string, prefill?: string) => {
            editorOpened += 1;
            assert.ok((prefill ?? "").length > 0);
            return "FROM EDITOR";
          },
          notify: (message: string) => {
            notifies.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;

      const edited = await runOptimizePromptConfig({ ctx: editCtx, agentDir: dir });
      assert.equal(edited.ok, true);
      assert.equal(editorOpened, 1);
      const after = loadOptimizePromptConfig(dir);
      assert.equal(after.ok, true);
      if (after.ok) assert.equal(after.config.systemPrompt, "FROM EDITOR");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("help arg shows config docs as markdown panel without calling the model", async () => {
    const panels: string[] = [];
    let completeCalls = 0;
    const ctx = {
      model: { provider: "tab", id: "main" },
      modelRegistry: {
        find: () => ({ provider: "tab", id: "main" }),
        getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
      },
      ui: {
        getEditorText: () => "draft",
        setEditorText: () => undefined,
        setWidget: () => undefined,
        notify: () => {
          throw new Error("help must not fall back to notify when showMarkdown is set");
        },
      },
    } as unknown as ExtensionCommandContext;

    const result = await runOptimizePrompt({
      ctx,
      args: "help",
      getThinkingLevel: () => "medium",
      agentDir: "/tmp/agent-dir",
      showMarkdown: (markdown) => {
        panels.push(markdown);
      },
      complete: async () => {
        completeCalls += 1;
        return { content: [], stopReason: "stop" } as never;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "help");
    assert.equal(completeCalls, 0);
    assert.equal(panels.length, 1);
    assert.match(panels[0] ?? "", /optimize-prompt\.json/);
    assert.match(panels[0] ?? "", /systemPrompt/);
    assert.match(panels[0] ?? "", /^# opt-prompt/m);
  });

  it("/opt-prompt-cancel aborts completeSimple and keeps draft", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-cancel-"));
    try {
      let editor = "keep me";
      const commandHandlers = new Map<
        string,
        (args: string, ctx: ExtensionCommandContext) => Promise<void>
      >();
      const abortSlot: OptimizeAbortSlot = {};
      // Wire factory commands; cancel must share the same factory abort slot.
      optimizePrompt({
        registerCommand: (
          name: string,
          options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) => {
          commandHandlers.set(name, options.handler);
        },
        registerEntryRenderer: () => undefined,
        getThinkingLevel: () => "off",
      } as never);

      const notifies: string[] = [];
      const ctx = {
        model: { provider: "tab", id: "main" },
        modelRegistry: {
          find: () => ({ provider: "tab", id: "main" }),
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
        },
        ui: {
          getEditorText: () => editor,
          setEditorText: (text: string) => {
            editor = text;
          },
          setWidget: (
            _key: string,
            content:
              | undefined
              | ((
                  tui: { requestRender: () => void },
                  theme: { fg: (c: string, t: string) => string },
                ) => { dispose?: () => void }),
          ) => {
            if (typeof content === "function") {
              content(
                { requestRender: () => undefined },
                { fg: (_c: string, t: string) => t },
              ).dispose?.();
            }
          },
          notify: (message: string) => {
            notifies.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;

      // Direct run with factory-equivalent slot (handler path uses completeSimple).
      const resultPromise = runOptimizePrompt({
        ctx,
        args: "rewrite this",
        getThinkingLevel: () => "off",
        agentDir: dir,
        abortSlot,
        complete: async (_model, _context, options) => {
          // Simulate in-flight cancel on the same slot the factory would use.
          assert.equal(cancelOptimize(abortSlot), true);
          assert.equal(options?.signal?.aborted, true);
          throw new Error("aborted");
        },
      });

      const result = await resultPromise;
      assert.equal(result.ok, false);
      assert.equal(result.reason, "cancelled");
      assert.equal(editor, "keep me");
      assert.match(notifies.join("\n"), /cancelled/i);

      // Slash cancel with nothing running (factory-local slot is empty).
      notifies.length = 0;
      await commandHandlers.get("opt-prompt-cancel")?.("", ctx);
      assert.match(notifies.join("\n"), /No optimize run/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("cancel on one abort slot does not abort another tab's run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-slot-"));
    try {
      let editorA = "draft-a";
      let editorB = "draft-b";
      const slotA: OptimizeAbortSlot = {};
      const slotB: OptimizeAbortSlot = {};

      const makeCtx = (get: () => string, set: (t: string) => void): ExtensionCommandContext =>
        ({
          model: { provider: "tab", id: "main" },
          modelRegistry: {
            find: () => ({ provider: "tab", id: "main" }),
            getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
          },
          ui: {
            getEditorText: get,
            setEditorText: set,
            setWidget: () => undefined,
            notify: () => undefined,
          },
        }) as unknown as ExtensionCommandContext;

      // Wait until both tabs have entered complete (slots assigned) before canceling A.
      const entered: Array<() => void> = [];
      const bothEntered = new Promise<void>((resolve) => {
        const check = () => {
          if (entered.length >= 2) resolve();
        };
        entered.push = ((fn: () => void) => {
          Array.prototype.push.call(entered, fn);
          check();
          return entered.length;
        }) as typeof entered.push;
      });
      const { promise: holdB, resolve: releaseB } = Promise.withResolvers<void>();

      const runA = runOptimizePrompt({
        ctx: makeCtx(
          () => editorA,
          (t) => {
            editorA = t;
          },
        ),
        args: "a",
        getThinkingLevel: () => "off",
        agentDir: dir,
        abortSlot: slotA,
        complete: async (_m, _c, options) => {
          entered.push(() => undefined);
          await bothEntered;
          assert.equal(cancelOptimize(slotA), true);
          assert.equal(options?.signal?.aborted, true);
          // Sibling tab must stay live.
          assert.equal(slotB.controller?.signal.aborted, false);
          releaseB();
          throw new Error("aborted");
        },
      });

      const runB = runOptimizePrompt({
        ctx: makeCtx(
          () => editorB,
          (t) => {
            editorB = t;
          },
        ),
        args: "b",
        getThinkingLevel: () => "off",
        agentDir: dir,
        abortSlot: slotB,
        complete: async (_m, _c, options) => {
          entered.push(() => undefined);
          await bothEntered;
          await holdB;
          assert.equal(options?.signal?.aborted, false);
          return {
            content: [{ type: "text", text: "optimized-b" }],
            stopReason: "stop",
          } as never;
        },
      });

      const [resultA, resultB] = await Promise.all([runA, runB]);
      assert.equal(resultA.ok, false);
      assert.equal(resultA.reason, "cancelled");
      assert.equal(editorA, "draft-a");
      assert.equal(resultB.ok, true);
      assert.equal(editorB, "optimized-b");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps editor draft on failure and clears widget", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-optimize-fail-"));
    try {
      let editor = "untouched";
      const widgets: Array<string[] | undefined> = [];
      const notifies: string[] = [];
      const ctx = {
        model: { provider: "tab", id: "main" },
        modelRegistry: {
          find: () => ({ provider: "tab", id: "main" }),
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
        },
        ui: {
          getEditorText: () => editor,
          setEditorText: (text: string) => {
            editor = text;
          },
          setWidget: (_k: string, content: string[] | undefined) => {
            widgets.push(content);
          },
          notify: (message: string) => {
            notifies.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;

      const result = await runOptimizePrompt({
        ctx,
        args: "make a button",
        getThinkingLevel: () => "off",
        agentDir: dir,
        complete: async () => {
          throw new Error("network down");
        },
      });

      assert.equal(result.ok, false);
      assert.equal(editor, "untouched");
      assert.equal(widgets.at(-1), undefined);
      assert.match(notifies.join("\n"), /network down/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
