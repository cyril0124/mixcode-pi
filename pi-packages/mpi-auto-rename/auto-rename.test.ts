import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  loadAutoRenameConfig,
  parseAutoRenameConfig,
  resolveAutoRenameTarget,
  writeAutoRenameConfig,
} from "./config.js";
import { createAutoRenameConfigOverlay } from "./config-overlay.js";
import autoRename, {
  MAX_ATTEMPTS,
  MAX_CONTEXT_CHARS,
  RECENT_MESSAGE_WINDOW,
  buildConversationContext,
  buildTitlePrompt,
  cancelAutoRename,
  parseCandidateTitle,
  runAutoRename,
  runAutoRenameConfig,
  titleValidationError,
  type AutoRenameAbortSlot,
} from "./index.js";

const ABSENT_AGENT_DIR = path.join(os.tmpdir(), "mpi-auto-rename-absent");

function messageEntry(
  role: "user" | "assistant",
  text: string,
  extraContent: Array<Record<string, unknown>> = [],
) {
  return {
    type: "message",
    message: {
      role,
      content: [{ type: "text", text }, ...extraContent],
    },
  };
}

test("buildConversationContext keeps recent visible dialog and tails to the char budget", () => {
  const entries = [];
  for (let i = 0; i < RECENT_MESSAGE_WINDOW + 5; i++) {
    entries.push(messageEntry(i % 2 === 0 ? "user" : "assistant", `msg-${i}-${"x".repeat(80)}`));
  }
  entries.unshift({
    type: "compaction",
    summary: "Earlier work summarized here",
    firstKeptEntryId: "x",
    tokensBefore: 1,
  });
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret chain of thought" },
        { type: "text", text: "final answer text" },
        { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
      ],
    },
  });
  entries.push({
    type: "message",
    message: {
      role: "toolResult",
      content: [{ type: "text", text: "tool dump should not appear" }],
    },
  });

  const context = buildConversationContext(entries as never);
  assert.ok(context.length <= MAX_CONTEXT_CHARS);
  assert.match(context, /final answer text/);
  assert.doesNotMatch(context, /secret chain of thought/);
  assert.doesNotMatch(context, /tool dump should not appear/);
  assert.doesNotMatch(context, /Tool call/);
  // Window + tail means the oldest padded messages drop first.
  assert.doesNotMatch(context, /msg-0-/);
});

test("titleValidationError accepts 2-5 kebab segments under 50 chars", () => {
  assert.equal(titleValidationError("fix-login-button"), undefined);
  assert.equal(titleValidationError("fix-gpt-5-auth"), undefined);
  assert.equal(titleValidationError("ab-cd"), undefined);
  assert.ok(titleValidationError("ab"));
  assert.ok(titleValidationError("a"));
  assert.ok(titleValidationError("a-b-c-d-e-f"));
  assert.ok(titleValidationError("Fix Login"));
  assert.ok(titleValidationError("fix_login"));
  assert.ok(titleValidationError("123-456"));
  assert.ok(titleValidationError("a-".repeat(30).slice(0, 51)));
});

test("parseCandidateTitle strips first-line quotes without inventing kebab-case", () => {
  assert.equal(parseCandidateTitle('  "fix-login-button"  '), "fix-login-button");
  assert.equal(parseCandidateTitle("```\nfix-login-button\n```"), "fix-login-button");
  assert.equal(parseCandidateTitle("Fix Login Button"), "Fix Login Button");
});

test("buildTitlePrompt includes prior violation feedback on retries", () => {
  const first = buildTitlePrompt("User: hello");
  assert.match(first, /User: hello/);
  assert.doesNotMatch(first, /Previous invalid title/);

  const retry = buildTitlePrompt("User: hello", {
    raw: "Fix Login",
    error: "must be kebab-case with 2-5 segments",
  });
  assert.match(retry, /Previous invalid title: Fix Login/);
  assert.match(retry, /must be kebab-case with 2-5 segments/);
});

test("runAutoRename retries format failures up to five total calls then keeps old name", async () => {
  const calls: string[] = [];
  const names: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];

  const result = await runAutoRename({
    setSessionName: (name) => names.push(name),
    getThinkingLevel: () => "low",
    agentDir: ABSENT_AGENT_DIR,
    complete: async (_model, context) => {
      const prompt = JSON.stringify(context);
      calls.push(prompt);
      return {
        role: "assistant",
        content: [{ type: "text", text: "Not A Valid Title" }],
        stopReason: "stop",
      } as never;
    },
    ctx: {
      model: { provider: "test", id: "model", api: "openai-completions" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      sessionManager: {
        buildContextEntries: () => [messageEntry("user", "please rename this session about auth")],
        getSessionName: () => undefined,
      },
      ui: {
        notify: (message: string, level: string) => notices.push({ message, level }),
        confirm: async () => true,
        custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) => {
          void factory;
          return undefined;
        },
      },
      hasUI: false,
    } as unknown as ExtensionCommandContext,
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.equal(names.length, 0);
  assert.ok(notices.some((n) => n.level === "error"));
  assert.match(calls[1]!, /Previous invalid title/);
});

test("runAutoRename confirms overwrite and sets session name on valid title", async () => {
  const names: string[] = [];
  let confirmed = false;
  const notices: string[] = [];

  const result = await runAutoRename({
    setSessionName: (name) => names.push(name),
    getThinkingLevel: () => "off",
    agentDir: ABSENT_AGENT_DIR,
    complete: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "fix-auth-middleware" }],
        stopReason: "stop",
      }) as never,
    ctx: {
      model: { provider: "test", id: "model", api: "openai-completions" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      sessionManager: {
        buildContextEntries: () => [messageEntry("user", "fix auth middleware race")],
        getSessionName: () => "old-title",
      },
      ui: {
        notify: (message: string) => notices.push(message),
        confirm: async (title: string) => {
          confirmed = true;
          assert.match(title, /old-title/);
          assert.match(title, /fix-auth-middleware/);
          assert.match(title, /->/);
          return true;
        },
      },
      hasUI: false,
    } as unknown as ExtensionCommandContext,
  });

  assert.equal(result.ok, true);
  assert.equal(confirmed, true);
  assert.deepEqual(names, ["fix-auth-middleware"]);
  assert.ok(notices.some((n) => n.includes("fix-auth-middleware")));
});

test("runAutoRename surfaces request errors without retrying", async () => {
  let calls = 0;
  const notices: Array<{ message: string; level: string }> = [];

  const result = await runAutoRename({
    setSessionName: () => {
      throw new Error("should not rename");
    },
    getThinkingLevel: () => "medium",
    agentDir: ABSENT_AGENT_DIR,
    complete: async () => {
      calls += 1;
      throw new Error("429 rate limited");
    },
    ctx: {
      model: { provider: "test", id: "model", api: "openai-completions" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      sessionManager: {
        buildContextEntries: () => [messageEntry("user", "hello")],
        getSessionName: () => undefined,
      },
      ui: {
        notify: (message: string, level: string) => notices.push({ message, level }),
        confirm: async () => true,
      },
      hasUI: false,
    } as unknown as ExtensionCommandContext,
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.ok(notices.some((n) => n.level === "error" && /429 rate limited/.test(n.message)));
});

test("extension registers /auto-rename, cancel, and config completions", () => {
  const commands: string[] = [];
  let hasConfigCompletion = false;
  const pi = {
    registerCommand: (
      name: string,
      options?: { getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null },
    ) => {
      commands.push(name);
      if (name === "auto-rename") {
        const found = options?.getArgumentCompletions?.("c") ?? [];
        hasConfigCompletion = found.some((item) => item.value === "config");
      }
    },
    setSessionName: () => undefined,
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;

  autoRename(pi);
  assert.deepEqual(commands, ["auto-rename", "auto-rename-cancel"]);
  assert.equal(hasConfigCompletion, true);
});

test("resolveAutoRenameTarget inherits session unless config overrides", () => {
  const active = { provider: "a", modelId: "m1" };
  assert.deepEqual(resolveAutoRenameTarget(active), active);
  assert.deepEqual(resolveAutoRenameTarget(active, { model: "inherit" }), active);
  assert.deepEqual(resolveAutoRenameTarget(active, { model: "b/m2" }), {
    provider: "b",
    modelId: "m2",
  });
  assert.deepEqual(resolveAutoRenameTarget(active, { model: "bad" }), active);
});

test("parseAutoRenameConfig keeps only a non-empty model field", () => {
  assert.deepEqual(parseAutoRenameConfig({ model: "  acme/cheap  ", extra: 1 }), {
    model: "acme/cheap",
  });
  assert.deepEqual(parseAutoRenameConfig({ model: "   " }), {});
  assert.deepEqual(parseAutoRenameConfig(null), {});
});

test("runAutoRename shows a one-line aboveEditor widget and clears it", async () => {
  const widgetPayloads: unknown[] = [];
  const names: string[] = [];

  const result = await runAutoRename({
    setSessionName: (name) => names.push(name),
    getThinkingLevel: () => "low",
    agentDir: ABSENT_AGENT_DIR,
    complete: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "fix-auth-middleware" }],
        stopReason: "stop",
      }) as never,
    ctx: {
      model: { provider: "test", id: "model", api: "openai-completions" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      sessionManager: {
        buildContextEntries: () => [messageEntry("user", "please rename this session about auth")],
        getSessionName: () => undefined,
      },
      ui: {
        notify: () => undefined,
        confirm: async () => true,
        setWidget: (
          _key: string,
          content:
            | undefined
            | ((
                tui: { requestRender: () => void },
                theme: { fg: (c: string, t: string) => string; bold?: (t: string) => string },
              ) => { render: () => string[]; dispose?: () => void }),
          options?: { placement?: string },
        ) => {
          widgetPayloads.push(content);
          if (typeof content === "function") {
            assert.equal(options?.placement, "aboveEditor");
            const component = content(
              { requestRender: () => undefined },
              {
                fg: (c: string, t: string) => `[${c}]${t}`,
                bold: (t: string) => t,
              },
            );
            const lines = component.render();
            const text = lines.join("\n");
            assert.equal(lines.length, 1);
            assert.match(text, /Generating title/);
            assert.match(text, /test\/model/);
            assert.match(text, /think:low/);
            assert.match(text, /\d+ chars/);
            assert.match(text, /\/auto-rename-cancel/);
            assert.doesNotMatch(text, /└─/);
            assert.doesNotMatch(text, /User:/);
            component.dispose?.();
          }
        },
      },
      hasUI: true,
    } as unknown as ExtensionCommandContext,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(names, ["fix-auth-middleware"]);
  assert.equal(typeof widgetPayloads[0], "function");
  assert.equal(widgetPayloads.at(-1), undefined);
});

test("cancelAutoRename aborts a hung generate and does not rename", async () => {
  const names: string[] = [];
  const abortSlot: AutoRenameAbortSlot = {};
  const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
  const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
  const widgetPayloads: unknown[] = [];

  const runPromise = runAutoRename({
    setSessionName: (name) => names.push(name),
    getThinkingLevel: () => "off",
    agentDir: ABSENT_AGENT_DIR,
    abortSlot,
    complete: async (_model, _context, options) => {
      markEntered();
      await hang;
      if (options?.signal?.aborted) {
        return { role: "assistant", content: [], stopReason: "aborted" } as never;
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: "should-not-land" }],
        stopReason: "stop",
      } as never;
    },
    ctx: {
      model: { provider: "test", id: "model", api: "openai-completions" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      sessionManager: {
        buildContextEntries: () => [messageEntry("user", "hello")],
        getSessionName: () => undefined,
      },
      ui: {
        notify: () => undefined,
        confirm: async () => true,
        setWidget: (_key: string, content: unknown) => {
          widgetPayloads.push(content);
        },
      },
      hasUI: true,
    } as unknown as ExtensionCommandContext,
  });

  await entered;
  assert.equal(typeof widgetPayloads[0], "function");
  assert.equal(cancelAutoRename(abortSlot), true);
  assert.equal(widgetPayloads.at(-1), undefined);
  releaseHang();
  const result = await runPromise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.deepEqual(names, []);
});

test("idle cancelAutoRename returns false", () => {
  assert.equal(cancelAutoRename({}), false);
});

test("starting a new auto-rename aborts the previous run on the same slot", async () => {
  const abortSlot: AutoRenameAbortSlot = {};
  const { promise: holdFirst, resolve: releaseFirst } = Promise.withResolvers<void>();
  const { promise: firstEntered, resolve: markFirst } = Promise.withResolvers<void>();
  const titles: string[] = [];
  let firstAborted = false;

  const ctx = {
    model: { provider: "test", id: "model", api: "openai-completions" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
    },
    sessionManager: {
      buildContextEntries: () => [messageEntry("user", "hello")],
      getSessionName: () => undefined,
    },
    ui: {
      notify: () => undefined,
      confirm: async () => true,
      setWidget: () => undefined,
    },
    hasUI: false,
  } as unknown as ExtensionCommandContext;

  const first = runAutoRename({
    setSessionName: () => {
      throw new Error("first run should not rename");
    },
    getThinkingLevel: () => "off",
    agentDir: ABSENT_AGENT_DIR,
    abortSlot,
    complete: async (_m, _c, options) => {
      markFirst();
      await holdFirst;
      firstAborted = Boolean(options?.signal?.aborted);
      return { role: "assistant", content: [], stopReason: "aborted" } as never;
    },
    ctx,
  });

  await firstEntered;
  const second = await runAutoRename({
    setSessionName: (name) => titles.push(name),
    getThinkingLevel: () => "off",
    agentDir: ABSENT_AGENT_DIR,
    abortSlot,
    complete: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "second-run-title" }],
        stopReason: "stop",
      }) as never,
    ctx,
  });
  releaseFirst();

  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.reason, "cancelled");
  assert.equal(firstAborted, true);
  assert.equal(second.ok, true);
  assert.deepEqual(titles, ["second-run-title"]);
});

test("runAutoRename uses configured model override", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-model-"));
  try {
    const written = writeAutoRenameConfig(dir, { model: "acme/cheap" });
    assert.equal(written.ok, true);
    const used: Array<{ provider: string; id: string }> = [];

    const result = await runAutoRename({
      setSessionName: () => undefined,
      getThinkingLevel: () => "off",
      agentDir: dir,
      complete: async (model) => {
        used.push({ provider: (model as { provider: string }).provider, id: (model as { id: string }).id });
        return {
          role: "assistant",
          content: [{ type: "text", text: "rename-with-override" }],
          stopReason: "stop",
        } as never;
      },
      ctx: {
        model: { provider: "test", id: "model", api: "openai-completions" },
        modelRegistry: {
          find: (provider: string, id: string) =>
            provider === "acme" && id === "cheap" ? { provider, id, api: "openai-completions" } : undefined,
          getApiKeyAndHeaders: async (model: { provider: string }) => {
            assert.equal(model.provider, "acme");
            return { ok: true, apiKey: "k" };
          },
        },
        sessionManager: {
          buildContextEntries: () => [messageEntry("user", "override model please")],
          getSessionName: () => undefined,
        },
        ui: {
          notify: () => undefined,
          confirm: async () => true,
          setWidget: () => undefined,
        },
        hasUI: false,
      } as unknown as ExtensionCommandContext,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(used, [{ provider: "acme", id: "cheap" }]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAutoRename rejects an unknown configured model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-unknown-"));
  try {
    writeAutoRenameConfig(dir, { model: "nope/missing" });
    const notices: Array<{ message: string; level: string }> = [];
    let completeCalls = 0;

    const result = await runAutoRename({
      setSessionName: () => {
        throw new Error("should not rename");
      },
      getThinkingLevel: () => "off",
      agentDir: dir,
      complete: async () => {
        completeCalls += 1;
        return { role: "assistant", content: [], stopReason: "stop" } as never;
      },
      ctx: {
        model: { provider: "test", id: "model", api: "openai-completions" },
        modelRegistry: {
          find: () => undefined,
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
        },
        sessionManager: {
          buildContextEntries: () => [messageEntry("user", "hello")],
          getSessionName: () => undefined,
        },
        ui: {
          notify: (message: string, level: string) => notices.push({ message, level }),
          confirm: async () => true,
        },
        hasUI: false,
      } as unknown as ExtensionCommandContext,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown_model");
    assert.equal(completeCalls, 0);
    assert.ok(notices.some((n) => n.level === "error" && /nope\/missing/.test(n.message)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runAutoRename reports invalid config JSON without calling the model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-bad-json-"));
  try {
    await fs.writeFile(path.join(dir, "auto-rename.json"), "{not-json", "utf8");
    let completeCalls = 0;
    const notices: string[] = [];

    const result = await runAutoRename({
      setSessionName: () => {
        throw new Error("should not rename");
      },
      getThinkingLevel: () => "off",
      agentDir: dir,
      complete: async () => {
        completeCalls += 1;
        return { role: "assistant", content: [], stopReason: "stop" } as never;
      },
      ctx: {
        model: { provider: "test", id: "model", api: "openai-completions" },
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
        },
        sessionManager: {
          buildContextEntries: () => [messageEntry("user", "hello")],
          getSessionName: () => undefined,
        },
        ui: {
          notify: (message: string) => notices.push(message),
          confirm: async () => true,
        },
        hasUI: false,
      } as unknown as ExtensionCommandContext,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_config");
    assert.equal(completeCalls, 0);
    assert.ok(notices.some((n) => /config error/i.test(n)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("config overlay Enter persists the selected model and closes", async () => {
  const changes: Array<{ model?: string }> = [];
  const results: Array<{ action: string }> = [];
  const view = createAutoRenameConfigOverlay({
    theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    requestRender: () => undefined,
    done: (result) => results.push(result),
    onChange: (config) => changes.push(config),
    initial: {},
    modelOptions: ["tab/main", "acme/cheap"],
  });

  const rendered = view.render(60).join("\n");
  assert.match(rendered, /Auto-rename model/);
  assert.match(rendered, /inherit/);
  assert.match(rendered, /acme\/cheap/);

  view.handleInput("\x1b[B"); // inherit -> first listed model
  view.handleInput("\r");
  assert.deepEqual(changes.at(-1), { model: "tab/main" });
  assert.deepEqual(results.at(-1), { action: "close" });
});

test("runAutoRenameConfig writes the picked model to auto-rename.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-config-cmd-"));
  try {
    const result = await runAutoRenameConfig({
      agentDir: dir,
      ctx: {
        model: { provider: "tab", id: "main" },
        modelRegistry: {
          getAvailable: () => [{ provider: "acme", id: "cheap" }],
        },
        ui: {
          custom: async (
            factory: (
              tui: { requestRender: () => void; terminal: { rows: number; columns: number } },
              theme: { fg: (c: string, t: string) => string },
              kb: unknown,
              done: (value: unknown) => void,
            ) => { handleInput(data: string): void },
          ) => {
            await new Promise<void>((resolve) => {
              const view = factory(
                { requestRender: () => undefined, terminal: { rows: 40, columns: 80 } },
                { fg: (_c: string, t: string) => t },
                {},
                () => resolve(),
              );
              view.handleInput("\x1b[B");
              view.handleInput("\r");
            });
          },
          notify: () => undefined,
        },
      } as unknown as ExtensionCommandContext,
    });

    assert.equal(result.ok, true);
    const loaded = loadAutoRenameConfig(dir);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.ok(loaded.config.model === "acme/cheap" || loaded.config.model === "tab/main");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
