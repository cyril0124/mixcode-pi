import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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
  shouldAutoRenameOnFirstMessage,
  titleValidationError,
  tryAutoRenameOnFirstMessage,
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
  assert.equal(MAX_CONTEXT_CHARS, 4000);
  assert.match(context, /final answer text/);
  assert.doesNotMatch(context, /secret chain of thought/);
  assert.doesNotMatch(context, /tool dump should not appear/);
  assert.doesNotMatch(context, /Tool call/);
  // Window + tail means the oldest padded messages drop first.
  assert.doesNotMatch(context, /msg-0-/);

  const tight = buildConversationContext(entries as never, 80);
  assert.equal(tight.length, 80);
  assert.match(tight, /final answer text/);
  assert.doesNotMatch(tight, /msg-1-/);
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
        content: [{ type: "text", text: "123-456" }],
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
        custom: async (
          factory: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (v: unknown) => void,
          ) => unknown,
        ) => {
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

function namedRenameCtx(options: {
  names: string[];
  notices: string[];
  select: (title: string, choices: string[]) => Promise<string | undefined>;
  // Loose params, strict return: runAutoRename consumes the AssistantMessage
  // text as the generated title, so mocks must honor that contract.
  complete?: (model?: unknown, context?: unknown, options?: unknown) => Promise<AssistantMessage>;
}) {
  return {
    setSessionName: (name: string) => options.names.push(name),
    getThinkingLevel: () => "off",
    agentDir: ABSENT_AGENT_DIR,
    complete:
      options.complete ??
      (async () =>
        ({
          role: "assistant",
          content: [{ type: "text", text: "Fix_Auth Middleware" }],
          stopReason: "stop",
        }) as never),
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
        notify: (message: string) => options.notices.push(message),
        select: options.select,
      },
      hasUI: false,
    } as unknown as ExtensionCommandContext,
  };
}

test("runAutoRename overwrites a named session when Yes is selected", async () => {
  const names: string[] = [];
  const notices: string[] = [];
  let selected = false;

  const result = await runAutoRename(
    namedRenameCtx({
      names,
      notices,
      select: async (title, choices) => {
        selected = true;
        assert.match(title, /old-title/);
        assert.match(title, /fix-auth-middleware/);
        assert.match(title, /->/);
        assert.match(title, /Overwrite the current session title/);
        assert.deepEqual(choices, ["Yes", "No", "Regenerate"]);
        return "Yes";
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(selected, true);
  assert.deepEqual(names, ["fix-auth-middleware"]);
  assert.ok(notices.some((n) => n.includes("fix-auth-middleware")));
});

test("runAutoRename keeps the existing title when No is selected", async () => {
  const names: string[] = [];
  const notices: string[] = [];

  const result = await runAutoRename(
    namedRenameCtx({
      names,
      notices,
      select: async () => "No",
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "declined");
  assert.deepEqual(names, []);
  assert.ok(notices.some((n) => n.includes("Kept existing title")));
});

test("runAutoRename keeps the existing title when overwrite select is dismissed", async () => {
  const names: string[] = [];
  const notices: string[] = [];

  const result = await runAutoRename(
    namedRenameCtx({
      names,
      notices,
      select: async () => undefined,
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "declined");
  assert.deepEqual(names, []);
  assert.ok(notices.some((n) => n.includes("Kept existing title")));
});

test("runAutoRename regenerates a different title then overwrites on Yes", async () => {
  const names: string[] = [];
  const notices: string[] = [];
  const prompts: string[] = [];
  const titles: string[] = [];
  let calls = 0;

  const result = await runAutoRename(
    namedRenameCtx({
      names,
      notices,
      complete: async (_model?: unknown, context?: unknown) => {
        calls += 1;
        prompts.push(JSON.stringify(context));
        return {
          role: "assistant",
          content: [
            {
              type: "text",
              text: calls === 1 ? "first-generated-title" : "second-generated-title",
            },
          ],
          stopReason: "stop",
        } as never;
      },
      select: async (title) => {
        titles.push(title);
        return title.includes("first-generated-title") ? "Regenerate" : "Yes";
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(titles.length, 2);
  assert.match(titles[0]!, /first-generated-title/);
  assert.match(titles[1]!, /second-generated-title/);
  assert.match(prompts[1]!, /first-generated-title/);
  assert.deepEqual(names, ["second-generated-title"]);
  assert.ok(notices.some((n) => n.includes("second-generated-title")));
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

test("extension registers /auto-rename, cancel, config completions, and first-message hook", () => {
  const commands: string[] = [];
  const events: string[] = [];
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
    on: (event: string) => {
      events.push(event);
    },
    setSessionName: () => undefined,
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;

  autoRename(pi);
  assert.deepEqual(commands, ["auto-rename", "auto-rename-cancel"]);
  assert.deepEqual(events, ["before_agent_start"]);
  assert.equal(hasConfigCompletion, true);
});

test("resolveAutoRenameTarget inherits session unless config overrides", () => {
  const active = { provider: "a", modelId: "m1", thinkingLevel: "medium" };
  assert.deepEqual(resolveAutoRenameTarget(active), active);
  assert.deepEqual(
    resolveAutoRenameTarget(active, { model: "inherit", thinking: "inherit" }),
    active,
  );
  assert.deepEqual(resolveAutoRenameTarget(active, { model: "b/m2", thinking: "high" }), {
    provider: "b",
    modelId: "m2",
    thinkingLevel: "high",
  });
  assert.deepEqual(resolveAutoRenameTarget(active, { model: "bad" }), active);
});

test("parseAutoRenameConfig keeps non-empty model and thinking fields", () => {
  assert.deepEqual(
    parseAutoRenameConfig({ model: "  acme/cheap  ", thinking: " low ", extra: 1 }),
    {
      model: "acme/cheap",
      thinking: "low",
    },
  );
  assert.deepEqual(parseAutoRenameConfig({ model: "   ", thinking: "   " }), {});
  assert.deepEqual(parseAutoRenameConfig(null), {});
});

test("parseAutoRenameConfig keeps boolean onFirstMessage only", () => {
  assert.deepEqual(parseAutoRenameConfig({ onFirstMessage: true }), { onFirstMessage: true });
  assert.deepEqual(parseAutoRenameConfig({ onFirstMessage: false }), { onFirstMessage: false });
  assert.deepEqual(parseAutoRenameConfig({ onFirstMessage: "true" }), {});
  assert.deepEqual(parseAutoRenameConfig({ onFirstMessage: 1 }), {});
});

test("parseAutoRenameConfig keeps positive integer maxContextChars only", () => {
  assert.deepEqual(parseAutoRenameConfig({ maxContextChars: 1000 }), { maxContextChars: 1000 });
  assert.deepEqual(parseAutoRenameConfig({ maxContextChars: 0 }), {});
  assert.deepEqual(parseAutoRenameConfig({ maxContextChars: -8 }), {});
  assert.deepEqual(parseAutoRenameConfig({ maxContextChars: 4000.5 }), {});
  assert.deepEqual(parseAutoRenameConfig({ maxContextChars: "4000" }), {});
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

test("$schema: accepted, ignored by resolution, preserved through write/load round-trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-schema-"));
  try {
    const parsed = parseAutoRenameConfig({
      $schema: "./mpi-auto-rename.schema.json",
      model: "acme/cheap",
    });
    assert.equal(parsed.schemaRef, "./mpi-auto-rename.schema.json");
    assert.equal(writeAutoRenameConfig(dir, parsed).ok, true);
    const raw = JSON.parse(await fs.readFile(path.join(dir, "mpi-auto-rename.json"), "utf8"));
    assert.deepEqual(Object.keys(raw), ["$schema", "model"]);
    const loaded = loadAutoRenameConfig(dir);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.config.schemaRef, "./mpi-auto-rename.schema.json");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
        used.push({
          provider: (model as { provider: string }).provider,
          id: (model as { id: string }).id,
        });
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
            provider === "acme" && id === "cheap"
              ? { provider, id, api: "openai-completions" }
              : undefined,
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

test("runAutoRename uses configured thinking override", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-thinking-"));
  try {
    const written = writeAutoRenameConfig(dir, { thinking: "high" });
    assert.equal(written.ok, true);
    const used: Array<string | undefined> = [];

    const result = await runAutoRename({
      setSessionName: () => undefined,
      getThinkingLevel: () => "off",
      agentDir: dir,
      complete: async (_model, _context, options) => {
        used.push(options?.reasoning);
        return {
          role: "assistant",
          content: [{ type: "text", text: "rename-with-thinking" }],
          stopReason: "stop",
        } as never;
      },
      ctx: {
        model: { provider: "test", id: "model", api: "openai-completions" },
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
        },
        sessionManager: {
          buildContextEntries: () => [messageEntry("user", "override thinking please")],
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
    assert.deepEqual(used, ["high"]);
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
    await fs.writeFile(path.join(dir, "mpi-auto-rename.json"), "{not-json", "utf8");
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

function plainTheme() {
  return { fg: (_c: string, text: string) => text, bold: (text: string) => text };
}

test("config overlay lists all settings and toggles onFirstMessage in place", () => {
  const changes: Array<Record<string, unknown>> = [];
  const view = createAutoRenameConfigOverlay({
    theme: plainTheme(),
    requestRender: () => undefined,
    done: () => undefined,
    onChange: (config) => {
      changes.push({ ...config });
    },
    initial: {},
    modelOptions: ["acme/cheap"],
    thinkingOptions: ["inherit", "low", "high"],
  });

  const main = view.render(60).join("\n");
  assert.match(main, /Auto-rename/);
  assert.match(main, /Model/);
  assert.match(main, /Thinking/);
  assert.match(main, /On first message/);
  assert.match(main, /Max context chars/);
  assert.match(main, /\boff\b/);
  assert.match(main, /\b4000\b/);

  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.match(view.render(60).join("\n"), /\bon\b/);
  assert.deepEqual(changes.at(-1), { onFirstMessage: true });

  view.handleInput("\r");
  assert.equal((changes.at(-1) as { onFirstMessage?: boolean }).onFirstMessage, undefined);
});

test("config overlay picks model and thinking from nested lists", () => {
  const changes: Array<Record<string, unknown>> = [];
  const view = createAutoRenameConfigOverlay({
    theme: plainTheme(),
    requestRender: () => undefined,
    done: () => undefined,
    onChange: (config) => {
      changes.push({ ...config });
    },
    initial: {},
    modelOptions: ["acme/cheap"],
    thinkingOptions: ["inherit", "low"],
  });

  view.handleInput("\r");
  assert.match(view.render(60).join("\n"), /Select model/);
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.deepEqual(changes.at(-1), { model: "acme/cheap" });

  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.match(view.render(60).join("\n"), /Select thinking/);
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.deepEqual(changes.at(-1), { model: "acme/cheap", thinking: "low" });
});

test("config overlay picks maxContextChars and omits the default", () => {
  const changes: Array<Record<string, unknown>> = [];
  const view = createAutoRenameConfigOverlay({
    theme: plainTheme(),
    requestRender: () => undefined,
    done: () => undefined,
    onChange: (config) => {
      changes.push({ ...config });
    },
    initial: {},
    modelOptions: ["acme/cheap"],
    thinkingOptions: ["inherit", "low"],
  });

  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.match(view.render(60).join("\n"), /Select max context chars/);
  view.handleInput("\x1b[A");
  view.handleInput("\r");
  assert.deepEqual(changes.at(-1), { maxContextChars: 1000 });

  view.handleInput("\r");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  assert.equal((changes.at(-1) as { maxContextChars?: number }).maxContextChars, undefined);
});

test("runAutoRenameConfig persists overlay edits to mpi-auto-rename.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-config-cmd-"));
  try {
    const result = await runAutoRenameConfig({
      agentDir: dir,
      ctx: {
        model: { provider: "tab", id: "main", reasoning: true },
        modelRegistry: {
          getAvailable: () => [{ provider: "acme", id: "cheap", reasoning: true }],
          find: (provider: string, id: string) =>
            provider === "acme" && id === "cheap" ? { provider, id, reasoning: true } : undefined,
        },
        ui: {
          custom: async (
            factory: (
              tui: { requestRender: () => void; terminal: { rows: number } },
              theme: { fg: (c: string, t: string) => string },
              kb: unknown,
              done: () => void,
            ) => { handleInput: (data: string) => void },
          ) => {
            let closed = false;
            const view = factory(
              { requestRender: () => undefined, terminal: { rows: 24 } },
              { fg: (_c: string, t: string) => t },
              undefined,
              () => {
                closed = true;
              },
            );
            view.handleInput("\x1b[B");
            view.handleInput("\x1b[B");
            view.handleInput("\r");
            view.handleInput("\x1b");
            assert.equal(closed, true);
          },
          notify: () => undefined,
        },
      } as unknown as ExtensionCommandContext,
    });

    assert.equal(result.ok, true);
    const loaded = loadAutoRenameConfig(dir);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.deepEqual(loaded.config, { onFirstMessage: true });
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("shouldAutoRenameOnFirstMessage only passes on an unnamed first user prompt", () => {
  const empty: never[] = [];
  const withUser = [messageEntry("user", "hello")] as never;
  assert.equal(
    shouldAutoRenameOnFirstMessage({ onFirstMessage: true, entries: empty, prompt: "fix login" }),
    true,
  );
  assert.equal(
    shouldAutoRenameOnFirstMessage({ onFirstMessage: false, entries: empty, prompt: "fix login" }),
    false,
  );
  assert.equal(shouldAutoRenameOnFirstMessage({ entries: empty, prompt: "fix login" }), false);
  assert.equal(
    shouldAutoRenameOnFirstMessage({
      onFirstMessage: true,
      entries: withUser,
      prompt: "second",
    }),
    false,
  );
  assert.equal(
    shouldAutoRenameOnFirstMessage({
      onFirstMessage: true,
      entries: empty,
      sessionName: "already-named",
      prompt: "fix login",
    }),
    false,
  );
  assert.equal(
    shouldAutoRenameOnFirstMessage({ onFirstMessage: true, entries: empty, prompt: "   " }),
    false,
  );
});

test("runAutoRename uses seedPrompt when the session has no context", async () => {
  const names: string[] = [];
  const prompts: string[] = [];
  const result = await runAutoRename({
    setSessionName: (name) => names.push(name),
    getThinkingLevel: () => "off",
    agentDir: ABSENT_AGENT_DIR,
    seedPrompt: "please rename this session about auth",
    complete: async (_model, context) => {
      prompts.push(JSON.stringify(context));
      return {
        role: "assistant",
        content: [{ type: "text", text: "fix-auth-middleware" }],
        stopReason: "stop",
      } as never;
    },
    ctx: {
      model: { provider: "test", id: "model", api: "openai-completions" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      sessionManager: {
        buildContextEntries: () => [],
        getSessionName: () => undefined,
      },
      ui: {
        notify: () => undefined,
        confirm: async () => true,
      },
      hasUI: false,
    } as unknown as ExtensionCommandContext,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(names, ["fix-auth-middleware"]);
  assert.match(prompts[0] ?? "", /please rename this session about auth/);
});

test("runAutoRename tails conversation context to configured maxContextChars", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-context-budget-"));
  try {
    writeAutoRenameConfig(dir, { maxContextChars: 40 });
    const prompts: string[] = [];
    const result = await runAutoRename({
      setSessionName: () => undefined,
      getThinkingLevel: () => "off",
      agentDir: dir,
      complete: async (_model, context) => {
        prompts.push(JSON.stringify(context));
        return {
          role: "assistant",
          content: [{ type: "text", text: "fix-auth-middleware" }],
          stopReason: "stop",
        } as never;
      },
      ctx: {
        model: { provider: "test", id: "model", api: "openai-completions" },
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
        },
        sessionManager: {
          buildContextEntries: () => [messageEntry("user", `HEAD-${"x".repeat(200)}-TAIL-MARKER`)],
          getSessionName: () => undefined,
        },
        ui: {
          notify: () => undefined,
          confirm: async () => true,
        },
        hasUI: false,
      } as unknown as ExtensionCommandContext,
    });

    assert.equal(result.ok, true);
    assert.match(prompts[0] ?? "", /TAIL-MARKER/);
    assert.doesNotMatch(prompts[0] ?? "", /HEAD-/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function firstMessageCtx(entries: unknown[], sessionName?: string) {
  const notices: Array<{ message: string; level?: string }> = [];
  return {
    notices,
    ctx: {
      model: { provider: "test", id: "model", api: "openai-completions" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      sessionManager: {
        buildContextEntries: () => entries,
        getSessionName: () => sessionName,
      },
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        confirm: async () => true,
      },
      hasUI: false,
    } as unknown as ExtensionCommandContext,
  };
}

test("tryAutoRenameOnFirstMessage starts only for an enabled unnamed first prompt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-first-"));
  try {
    writeAutoRenameConfig(dir, { onFirstMessage: true });
    const names: string[] = [];
    const { ctx, notices } = firstMessageCtx([]);
    const started = tryAutoRenameOnFirstMessage({
      prompt: "fix the login button race",
      ctx,
      setSessionName: (name) => names.push(name),
      getThinkingLevel: () => "off",
      agentDir: dir,
      complete: async () =>
        ({
          role: "assistant",
          content: [{ type: "text", text: "fix-login-button" }],
          stopReason: "stop",
        }) as never,
    });
    assert.ok(started);
    const result = await started;
    assert.equal(result.ok, true);
    assert.deepEqual(names, ["fix-login-button"]);
    assert.ok(notices.some((n) => n.message.includes("fix-login-button")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tryAutoRenameOnFirstMessage skips off, history, named, and empty prompts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-skip-"));
  try {
    let completeCalls = 0;
    const complete = async () => {
      completeCalls += 1;
      return { role: "assistant", content: [], stopReason: "stop" } as never;
    };
    const run = (opts: {
      config?: { onFirstMessage?: boolean };
      entries?: unknown[];
      sessionName?: string;
      prompt: string;
    }) => {
      writeAutoRenameConfig(dir, opts.config ?? {});
      const { ctx, notices } = firstMessageCtx(opts.entries ?? [], opts.sessionName);
      const started = tryAutoRenameOnFirstMessage({
        prompt: opts.prompt,
        ctx,
        setSessionName: () => {
          throw new Error("should not rename");
        },
        getThinkingLevel: () => "off",
        agentDir: dir,
        complete,
      });
      return { started, notices };
    };

    assert.equal(run({ prompt: "fix login" }).started, undefined);
    assert.equal(
      run({
        config: { onFirstMessage: true },
        entries: [messageEntry("user", "old")],
        prompt: "next",
      }).started,
      undefined,
    );
    assert.equal(
      run({ config: { onFirstMessage: true }, sessionName: "kept", prompt: "fix login" }).started,
      undefined,
    );
    assert.equal(run({ config: { onFirstMessage: true }, prompt: "   " }).started, undefined);
    assert.equal(completeCalls, 0);
    assert.deepEqual(run({ prompt: "fix login" }).notices, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
