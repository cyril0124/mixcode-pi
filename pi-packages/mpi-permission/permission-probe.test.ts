import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import permissionExtension from "./index.js";

test("permission_probe stays inactive until enabled and never executes targets", async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-permission-probe-work-"));
  try {
    const tools = new Map<string, any>();
    const active = ["read"];
    const events = new Map<string, (...args: any[]) => void>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    let targetExecutions = 0;
    const pi = {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      getAllTools: () => [...tools.values()],
      getActiveTools: () => active.slice(),
      setActiveTools(names: string[]) {
        active.splice(0, active.length, ...names);
      },
      on(name: string, handler: (...args: any[]) => void) {
        events.set(name, handler);
      },
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: any) => Promise<void> },
      ) {
        commands.set(name, definition);
      },
    } as any;
    permissionExtension(pi);
    tools.set("test_tool", {
      name: "test_tool",
      parameters: Type.Object({ value: Type.String() }),
      async execute() {
        targetExecutions += 1;
        return { content: [{ type: "text", text: "executed" }], details: {} };
      },
    });

    assert.ok(tools.has("permission_probe"));
    const ctx = { cwd: workDir, isProjectTrusted: () => true };
    events.get("session_start")!({ reason: "startup" }, ctx);
    assert.deepEqual(active, ["read"]);
    assert.ok(commands.has("permission-probe"));
    await commands.get("permission-probe")!.handler("", {
      hasUI: true,
      ui: { notify() {} },
    });
    assert.deepEqual(active, ["read", "permission_probe"]);
    await commands.get("permission-probe")!.handler("", {
      hasUI: true,
      ui: { notify() {} },
    });
    assert.deepEqual(active, ["read", "permission_probe"]);
    events.get("before_agent_start")!({}, ctx);
    assert.deepEqual(active, ["read", "permission_probe"]);

    const probe = tools.get("permission_probe");
    const invalid = await probe.execute(
      "probe-1",
      { toolName: "test_tool", input: {} },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(invalid.details.error, "invalid_target_input");
    const valid = await probe.execute(
      "probe-2",
      { toolName: "test_tool", input: { value: "ok" } },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(valid.details.action, "allow");
    assert.equal(targetExecutions, 0);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
