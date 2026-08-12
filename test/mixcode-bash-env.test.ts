import assert from "node:assert/strict";
import { test } from "node:test";
import { createMixCodeBashCustomTools } from "../src/agent/mixcode-bash-env.js";

test("createMixCodeBashCustomTools registers bash override", () => {
  const tools = createMixCodeBashCustomTools(
    process.cwd(),
    {
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
    } as never,
    () => ({ tabTitle: "Agent-01", focusedTabTitle: "Agent-02" }),
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "bash");
});
