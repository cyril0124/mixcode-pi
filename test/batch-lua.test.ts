import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  applyBatchRequests,
  contextFromState,
  executeBatchScript,
  renderTemplate,
  runLuaScript,
  type BatchExecutorHost,
  type BatchTabRequest,
} from "../src/core/batch-lua.js";
import { parseMainArgs } from "../src/cli/main.js";
import { createInitialState, createTab } from "../src/index.js";
import type { MixCodeModelRef } from "../src/core/types.js";

// --- parseMainArgs --batch tests ---

test("parseMainArgs parses --batch flag", () => {
  const result = parseMainArgs(["--batch", "/tmp/script.lua"], "/home/user");
  assert.equal(result.batch, "/tmp/script.lua");
  assert.equal(result.workdir, "/home/user");
});

test("parseMainArgs parses --batch= form", () => {
  const result = parseMainArgs(["--batch=./tasks.lua"], "/home/user");
  assert.equal(result.batch, "/home/user/tasks.lua");
});

test("parseMainArgs combines --workdir and --batch", () => {
  const result = parseMainArgs(["--workdir", "/proj", "--batch", "run.lua"], "/home/user");
  assert.equal(result.workdir, "/proj");
  assert.equal(result.batch, "/proj/run.lua");
});

test("parseMainArgs throws on --batch without value", () => {
  assert.throws(() => parseMainArgs(["--batch"], "/home/user"), /--batch requires a file path/);
});

test("parseMainArgs throws on --batch= with empty value", () => {
  assert.throws(() => parseMainArgs(["--batch="], "/home/user"), /--batch requires a file path/);
});

// --- runLuaScript tests ---

test("runLuaScript collects open_tab calls", async () => {
  const script = `
    mixcode.open_tab({ name = "agent-1", prompt = "hello" })
    mixcode.open_tab({ name = "agent-2", prompt = "world", workdir = "/tmp" })
  `;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.name, "agent-1");
  assert.equal(requests[0]!.prompt, "hello");
  assert.equal(requests[0]!.workdir, undefined);
  assert.equal(requests[1]!.name, "agent-2");
  assert.equal(requests[1]!.prompt, "world");
  assert.equal(requests[1]!.workdir, "/tmp");
});

test("runLuaScript collects model and thinking fields", async () => {
  const script = `
    mixcode.open_tab({
      name = "agent-1",
      prompt = "do stuff",
      model = "anthropic/claude-sonnet",
      thinking = "high"
    })
  `;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.model, "anthropic/claude-sonnet");
  assert.equal(requests[0]!.thinking, "high");
});

test("runLuaScript throws on Lua syntax error", async () => {
  const script = `mixcode.open_tab({ name = "x", prompt = `;
  await assert.rejects(() => runLuaScript(script, "bad.lua"), /Lua error in bad\.lua/);
});

test("runLuaScript throws when name is missing", async () => {
  const script = `mixcode.open_tab({ prompt = "hello" })`;
  await assert.rejects(() => runLuaScript(script, "test.lua"), /name.*required/);
});

test("runLuaScript throws when prompt is missing", async () => {
  const script = `mixcode.open_tab({ name = "x" })`;
  await assert.rejects(() => runLuaScript(script, "test.lua"), /prompt.*required/);
});

test("runLuaScript throws when argument is not a table", async () => {
  const script = `mixcode.open_tab("hello")`;
  await assert.rejects(() => runLuaScript(script, "test.lua"), /expects a table/);
});

test("runLuaScript supports Lua control flow", async () => {
  const script = `
    local agents = {"a", "b", "c"}
    for _, name in ipairs(agents) do
      mixcode.open_tab({ name = name, prompt = "task for " .. name })
    end
  `;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.name, "a");
  assert.equal(requests[0]!.prompt, "task for a");
  assert.equal(requests[2]!.name, "c");
});

test("runLuaScript returns empty array when no open_tab calls", async () => {
  const script = `local x = 1 + 2`;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests.length, 0);
});

test("runLuaScript exposes current_workdir", async () => {
  const script = `
    mixcode.open_tab({ name = "wd", prompt = mixcode.current_workdir() })
  `;
  const requests = await runLuaScript(script, "test.lua", { workdir: "/repo", tabs: [] });
  assert.equal(requests[0]!.prompt, "/repo");
});

test("runLuaScript exposes tab_exists", async () => {
  const script = `
    if mixcode.tab_exists("known") then
      mixcode.open_tab({ name = "known", prompt = "exists" })
    else
      mixcode.open_tab({ name = "known", prompt = "missing" })
    end
  `;
  const requests = await runLuaScript(script, "test.lua", {
    workdir: "/repo",
    tabs: [{ name: "known", sessionId: "s1", workdir: "/repo", model: "m", thinking: "high", status: "idle" }],
  });
  assert.equal(requests[0]!.prompt, "exists");
});

test("runLuaScript exposes list_tabs", async () => {
  const script = `
    local tabs = mixcode.list_tabs()
    mixcode.open_tab({ name = "summary", prompt = tabs[1].name .. ":" .. tabs[1].model .. ":" .. tabs[1].thinking })
  `;
  const requests = await runLuaScript(script, "test.lua", {
    workdir: "/repo",
    tabs: [{ name: "agent", sessionId: "s1", workdir: "/repo", model: "provider/model", thinking: "low", status: "idle" }],
  });
  assert.equal(requests[0]!.prompt, "agent:provider/model:low");
});

test("runLuaScript exposes mixcode.render", async () => {
  const script = `
    mixcode.open_tab({ name = "render", prompt = mixcode.render("hello {aaa}!", { aaa = "world" }) })
  `;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests[0]!.prompt, "hello world!");
});

test("runLuaScript exposes global render", async () => {
  const script = `
    mixcode.open_tab({ name = "render", prompt = render("n={n}, b={b}", { n = 42, b = true }) })
  `;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests[0]!.prompt, "n=42, b=true");
});

test("runLuaScript render supports escaped braces", async () => {
  const script = `
    mixcode.open_tab({ name = "render", prompt = render("literal {{name}} = {name}", { name = "world" }) })
  `;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests[0]!.prompt, "literal {name} = world");
});

test("runLuaScript render throws on missing variable", async () => {
  const script = `mixcode.open_tab({ name = "x", prompt = render("hello {name}", {}) })`;
  await assert.rejects(() => runLuaScript(script, "test.lua"), /Missing template variable: name/);
});

test("renderTemplate rejects invalid variables", () => {
  assert.throws(() => renderTemplate("hello {a.b}", () => "x"), /Invalid template variable/);
  assert.throws(() => renderTemplate("hello {", () => "x"), /Unclosed/);
  assert.throws(() => renderTemplate("hello }", () => "x"), /Unexpected/);
});

test("contextFromState exposes batch Lua context from state tabs", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo/pkg", { title: "agent" }));
  const context = contextFromState(state);
  assert.equal(context.workdir, "/repo");
  assert.equal(context.tabs[0]!.name, "agent");
  assert.equal(context.tabs[0]!.sessionId, "s1");
  assert.equal(context.tabs[0]!.workdir, "/repo/pkg");
});

// --- applyBatchRequests tests ---

function createMockHost(
  existingTabs: Array<{ title: string; sessionId: string; model?: MixCodeModelRef }> = [],
): BatchExecutorHost & {
  created: BatchTabRequest[];
  inputs: Array<{ sessionId: string; input: string }>;
  cleared: string[];
  deleted: string[];
  configured: Array<{ sessionId: string; model?: string; thinking?: string }>;
} {
  const state = createInitialState("/test");
  state.tabs.push(
    ...existingTabs.map((tab, index) =>
      createTab(index + 1, tab.sessionId, "/test", {
        title: tab.title,
        ...(tab.model ? { model: tab.model } : {}),
      }),
    ),
  );
  const created: BatchTabRequest[] = [];
  const inputs: Array<{ sessionId: string; input: string }> = [];
  const cleared: string[] = [];
  const deleted: string[] = [];
  const configured: Array<{ sessionId: string; model?: string; thinking?: string }> = [];
  return {
    state,
    created,
    inputs,
    cleared,
    deleted,
    configured,
    findTabByTitle(title) {
      const tab = existingTabs.find((t) => t.title === title);
      return tab ? { sessionId: tab.sessionId } : undefined;
    },
    async createNewTab(request) {
      created.push(request);
      const sessionId = `new-${request.name}`;
      existingTabs.push({ title: request.name, sessionId });
      return sessionId;
    },
    async configureTab(sessionId, options) {
      configured.push({
        sessionId,
        model: options.model?.displayName,
        thinking: options.thinking,
      });
    },
    async clearTab(sessionId) {
      cleared.push(sessionId);
      const nextSessionId = `${sessionId}-cleared`;
      const tab = existingTabs.find((t) => t.sessionId === sessionId);
      if (tab) tab.sessionId = nextSessionId;
      return nextSessionId;
    },
    async deleteTab(sessionId) {
      deleted.push(sessionId);
      const index = existingTabs.findIndex((t) => t.sessionId === sessionId);
      if (index >= 0) existingTabs.splice(index, 1);
    },
    async submitInput(sessionId, input) {
      inputs.push({ sessionId, input });
    },
    resolveModel(query) {
      if (query === "unknown-model") throw new Error(`Unknown model: ${query}`);
      return {
        provider: "test",
        modelId: query,
        displayName: query,
        contextWindow: 200_000,
        reasoning: true,
        thinkingLevelMap: query === "max-model" ? { max: "max" } : undefined,
      };
    },
  };
}

test("applyBatchRequests creates new tabs and sends prompts", async () => {
  const host = createMockHost();
  const requests: BatchTabRequest[] = [
    { name: "agent-1", prompt: "hello" },
    { name: "agent-2", prompt: "world" },
  ];
  await applyBatchRequests(requests, host);
  assert.equal(host.created.length, 2);
  assert.equal(host.inputs.length, 2);
  assert.equal(host.inputs[0]!.sessionId, "new-agent-1");
  assert.equal(host.inputs[0]!.input, "hello");
  assert.equal(host.inputs[1]!.sessionId, "new-agent-2");
  assert.equal(host.inputs[1]!.input, "world");
});

test("applyBatchRequests reuses existing tab by title", async () => {
  const host = createMockHost([{ title: "existing-agent", sessionId: "sess-123" }]);
  const requests: BatchTabRequest[] = [{ name: "existing-agent", prompt: "reuse me" }];
  await applyBatchRequests(requests, host);
  assert.equal(host.created.length, 0);
  assert.equal(host.inputs.length, 1);
  assert.equal(host.inputs[0]!.sessionId, "sess-123");
  assert.equal(host.inputs[0]!.input, "reuse me");
});

test("applyBatchRequests throws on invalid thinking level", async () => {
  const host = createMockHost();
  const requests: BatchTabRequest[] = [{ name: "x", prompt: "y", thinking: "invalid" }];
  await assert.rejects(() => applyBatchRequests(requests, host), /Invalid thinking level/);
});

test("applyBatchRequests validates thinking against selected model capability", async () => {
  const host = createMockHost();
  await applyBatchRequests(
    [{ name: "x", prompt: "y", model: "max-model", thinking: "max" }],
    host,
  );
  assert.equal(host.configured[0]?.thinking, "max");
  await assert.rejects(
    () => applyBatchRequests([{ name: "z", prompt: "y", thinking: "max" }], host),
    /Invalid thinking level 'max'/,
  );
});

test("applyBatchRequests accepts max thinking from an existing tab model", async () => {
  const host = createMockHost([
    {
      title: "existing-max",
      sessionId: "s-max",
      model: {
        provider: "test",
        modelId: "max-model",
        displayName: "max-model",
        contextWindow: 200_000,
        reasoning: true,
        thinkingLevelMap: { max: "max" },
      },
    },
  ]);

  await applyBatchRequests(
    [{ name: "existing-max", prompt: "continue", thinking: "max" }],
    host,
  );

  assert.equal(host.configured[0]?.thinking, "max");
});

test("applyBatchRequests throws on unknown model", async () => {
  const host = createMockHost();
  const requests: BatchTabRequest[] = [{ name: "x", prompt: "y", model: "unknown-model" }];
  await assert.rejects(() => applyBatchRequests(requests, host), /Unknown model/);
});

test("applyBatchRequests does nothing for empty requests", async () => {
  const host = createMockHost();
  await applyBatchRequests([], host);
  assert.equal(host.created.length, 0);
  assert.equal(host.inputs.length, 0);
});

test("applyBatchRequests awaits same-tab prompts in order", async () => {
  const order: string[] = [];
  const host = createMockHost();
  let releaseFirst: (() => void) | undefined;
  host.submitInput = async (_sessionId, input) => {
    order.push(`start-${input}`);
    if (input === "1") {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    order.push(`end-${input}`);
  };

  const batch = applyBatchRequests(
    [
      { name: "same", prompt: "1" },
      { name: "same", prompt: "2" },
    ],
    host,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["start-1"]);
  releaseFirst?.();
  await batch;
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
});

test("applyBatchRequests runs all prompts in parallel", async () => {
  const order: string[] = [];
  const host = createMockHost();
  // Override submitInput to track execution order with delays
  host.submitInput = async (sessionId, input) => {
    order.push(`start-${sessionId}`);
    await new Promise((r) => setTimeout(r, 10));
    order.push(`end-${sessionId}`);
  };
  const requests: BatchTabRequest[] = [
    { name: "a", prompt: "1" },
    { name: "b", prompt: "2" },
  ];
  await applyBatchRequests(requests, host);
  // Both should start before either ends (parallel execution)
  assert.equal(order[0], "start-new-a");
  assert.equal(order[1], "start-new-b");
});

// --- executeBatchScript integration test ---

test("executeBatchScript reads file and applies requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batch-lua-"));
  try {
    const scriptPath = join(dir, "test.lua");
    await writeFile(
      scriptPath,
      'mixcode.open_tab({ name = "from-file", prompt = "file prompt" })\n',
    );
    const host = createMockHost();
    await executeBatchScript(scriptPath, host);
    assert.equal(host.created.length, 1);
    assert.equal(host.created[0]!.name, "from-file");
    assert.equal(host.inputs[0]!.input, "file prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executeBatchScript throws on missing file", async () => {
  const host = createMockHost();
  await assert.rejects(
    () => executeBatchScript("/nonexistent/path.lua", host),
    /ENOENT/,
  );
});

// --- mode tests ---

test("applyBatchRequests clears tab when mode is clear", async () => {
  const host = createMockHost([{ title: "my-agent", sessionId: "sess-1" }]);
  const requests: BatchTabRequest[] = [
    { name: "my-agent", prompt: "fresh start", mode: "clear" },
  ];
  await applyBatchRequests(requests, host);
  assert.equal(host.cleared.length, 1);
  assert.equal(host.cleared[0], "sess-1");
  assert.equal(host.inputs[0]!.sessionId, "sess-1-cleared");
  assert.equal(host.inputs[0]!.input, "fresh start");
});

test("applyBatchRequests does not clear tab when mode is append", async () => {
  const host = createMockHost([{ title: "my-agent", sessionId: "sess-1" }]);
  const requests: BatchTabRequest[] = [
    { name: "my-agent", prompt: "continue", mode: "append" },
  ];
  await applyBatchRequests(requests, host);
  assert.equal(host.cleared.length, 0);
  assert.equal(host.inputs[0]!.input, "continue");
});

test("applyBatchRequests defaults to append when mode is omitted", async () => {
  const host = createMockHost([{ title: "my-agent", sessionId: "sess-1" }]);
  const requests: BatchTabRequest[] = [
    { name: "my-agent", prompt: "keep going" },
  ];
  await applyBatchRequests(requests, host);
  assert.equal(host.cleared.length, 0);
  assert.equal(host.inputs[0]!.input, "keep going");
});

test("applyBatchRequests throws on invalid mode", async () => {
  const host = createMockHost();
  const requests: BatchTabRequest[] = [
    { name: "x", prompt: "y", mode: "invalid" as any },
  ];
  await assert.rejects(() => applyBatchRequests(requests, host), /Invalid mode/);
});

test("runLuaScript collects mode field", async () => {
  const script = `mixcode.open_tab({ name = "a", prompt = "b", mode = "clear" })`;
  const requests = await runLuaScript(script, "test.lua");
  assert.equal(requests[0]!.mode, "clear");
});

test("applyBatchRequests deletes old tab and creates fresh one when mode is delete", async () => {
  const host = createMockHost([{ title: "my-agent", sessionId: "sess-1" }]);
  const requests: BatchTabRequest[] = [
    { name: "my-agent", prompt: "start over", mode: "delete" },
  ];
  await applyBatchRequests(requests, host);
  assert.deepEqual(host.deleted, ["sess-1"]);
  assert.equal(host.created.length, 1);
  assert.equal(host.created[0]!.name, "my-agent");
  assert.equal(host.inputs[0]!.sessionId, "new-my-agent");
  assert.equal(host.inputs[0]!.input, "start over");
});

test("applyBatchRequests creates new tab when mode is delete and tab does not exist", async () => {
  const host = createMockHost();
  const requests: BatchTabRequest[] = [
    { name: "fresh", prompt: "hello", mode: "delete" },
  ];
  await applyBatchRequests(requests, host);
  assert.equal(host.deleted.length, 0);
  assert.equal(host.created.length, 1);
  assert.equal(host.inputs[0]!.sessionId, "new-fresh");
});

test("applyBatchRequests configures existing tab model and thinking", async () => {
  const host = createMockHost([{ title: "my-agent", sessionId: "sess-1" }]);
  await applyBatchRequests(
    [{ name: "my-agent", prompt: "hello", model: "test-model", thinking: "high" }],
    host,
  );
  assert.deepEqual(host.configured[0], {
    sessionId: "sess-1",
    model: "test-model",
    thinking: "high",
  });
  assert.equal(host.inputs[0]!.sessionId, "sess-1");
});

test("applyBatchRequests configures cleared tab using new session id", async () => {
  const host = createMockHost([{ title: "my-agent", sessionId: "sess-1" }]);
  await applyBatchRequests(
    [{ name: "my-agent", prompt: "hello", mode: "clear", model: "test-model", thinking: "low" }],
    host,
  );
  assert.deepEqual(host.configured[0], {
    sessionId: "sess-1-cleared",
    model: "test-model",
    thinking: "low",
  });
  assert.equal(host.inputs[0]!.sessionId, "sess-1-cleared");
});
