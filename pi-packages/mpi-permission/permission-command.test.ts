import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import permissionExtension from "./index.js";

type CommandDefinition = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
  handler: (args: string, ctx: any) => Promise<void>;
};

type Harness = {
  workDir: string;
  command: CommandDefinition;
  notices: Array<{ message: string; type?: string }>;
  events: Map<string, (...args: any[]) => any>;
  ctx: any;
  dispose: () => Promise<void>;
};

async function createHarness(): Promise<Harness> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-permission-command-"));
  const workDir = path.join(agentDir, "work");
  await fs.mkdir(workDir, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const active = ["read"];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => active.slice(),
    setActiveTools(names: string[]) {
      active.splice(0, active.length, ...names);
    },
    on(name: string, handler: (...args: any[]) => any) {
      events.set(name, handler);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
  } as any;
  permissionExtension(pi);

  const notices: Array<{ message: string; type?: string }> = [];
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    select: async (_title: string, options: string[]) => options[1],
    setWorkingMessage: () => {},
  };
  const ctx = {
    hasUI: true,
    cwd: workDir,
    ui,
    signal: new AbortController().signal,
    isProjectTrusted: () => true,
  };

  return {
    workDir,
    command: commands.get("permission")!,
    notices,
    events,
    ctx,
    async dispose() {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
    },
  };
}

test("/permission list reports every layer with its file, rules, and ignored state", async () => {
  const harness = await createHarness();
  try {
    const agentDir = path.dirname(harness.workDir);
    await fs.writeFile(
      path.join(agentDir, "mpi-permission.json"),
      JSON.stringify({
        bash: { "*": "ask", "rm *": { action: "deny", message: "no rm" } },
        external_directory: { "../*": "ask" },
      }),
    );

    await harness.command.handler("list", harness.ctx);
    const all = harness.notices.at(-1)!;
    assert.equal(all.type, "info");
    assert.match(all.message, /^global · .*mpi-permission\.json$/m);
    assert.match(all.message, /^ {2}bash\s+ask\s+\*$/m);
    assert.match(all.message, /^ {2}bash\s+deny\s+rm \*\s+"no rm"$/m);
    assert.match(all.message, /^ {2}external_directory\s+ask\s+\.\.\/\*$/m);
    assert.match(all.message, /^project · .*mpi-permission\.json \(not created\)$/m);
    assert.match(all.message, /^session · session \(in-memory\)$/m);
    assert.equal(all.message.match(/\(no rules\)/g)?.length, 2);

    await harness.command.handler("list session", harness.ctx);
    const sessionOnly = harness.notices.at(-1)!;
    assert.doesNotMatch(sessionOnly.message, /^global ·/m);
    assert.doesNotMatch(sessionOnly.message, /^project ·/m);
    assert.match(sessionOnly.message, /^session · session \(in-memory\)$/m);

    harness.ctx.isProjectTrusted = () => false;
    await harness.command.handler("list project", harness.ctx);
    assert.match(harness.notices.at(-1)!.message, /\(untrusted — ignored\)$/m);

    await harness.command.handler("list sideways", harness.ctx);
    assert.deepEqual(harness.notices.at(-1), {
      message: "Error: Usage: /permission [list [all|global|project|session] | probe [on|off]]",
      type: "error",
    });
  } finally {
    await harness.dispose();
  }
});

test("/permission list shows ask-dialog grants as session rules", async () => {
  const harness = await createHarness();
  try {
    await fs.writeFile(
      path.join(path.dirname(harness.workDir), "mpi-permission.json"),
      JSON.stringify({ bash: { "*": "ask" } }),
    );
    const blocked = await harness.events.get("tool_call")!(
      { toolName: "bash", input: { command: "git status" } },
      harness.ctx,
    );
    assert.equal(blocked, undefined);

    await harness.command.handler("list", harness.ctx);
    const listed = harness.notices.at(-1)!;
    assert.match(listed.message, /^session · session \(in-memory\)$/m);
    assert.match(listed.message, /^ {2}bash\s+allow\s+git status\*$/m);
  } finally {
    await harness.dispose();
  }
});

test("/permission completes the subcommand grammar", async () => {
  const harness = await createHarness();
  try {
    const complete = (prefix: string) => harness.command.getArgumentCompletions!(prefix);
    const values = (prefix: string) => (complete(prefix) ?? []).map((item) => item.value);
    assert.deepEqual(values(""), ["list", "probe"]);
    assert.deepEqual(values("li"), ["list"]);
    assert.deepEqual(values("probe o"), ["probe on", "probe off"]);
    assert.equal(complete("nope"), null);
    assert.equal(complete("list sideways"), null);

    // Pi replaces the whole argument text with item.value, so every candidate
    // must be a complete argument the dispatcher accepts on its own.
    for (const prefix of ["", "list ", "probe ", "probe o"]) {
      for (const item of complete(prefix) ?? []) {
        harness.notices.length = 0;
        await harness.command.handler(item.value, harness.ctx);
        assert.notEqual(
          harness.notices.at(-1)?.type,
          "error",
          `completion "${item.value}" is not a valid argument`,
        );
      }
    }
  } finally {
    await harness.dispose();
  }
});
