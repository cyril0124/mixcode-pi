import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import autoRename, {
  MAX_ATTEMPTS,
  MAX_CONTEXT_CHARS,
  RECENT_MESSAGE_WINDOW,
  buildConversationContext,
  buildTitlePrompt,
  parseCandidateTitle,
  runAutoRename,
  titleValidationError,
} from "./index.js";

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

test("extension registers /auto-rename command", () => {
  const commands: string[] = [];
  const pi = {
    registerCommand: (name: string) => {
      commands.push(name);
    },
    setSessionName: () => undefined,
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;

  autoRename(pi);
  assert.deepEqual(commands, ["auto-rename"]);
});
