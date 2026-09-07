import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import permissionExtension from "./index.js";

test("real session blocks tool execution and exposes the same message through the probe", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permission-denial-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const message = "请让用户手动执行。\nDo not retry this command.";
    await fs.writeFile(
      path.join(dir, "mpi-permission.json"),
      JSON.stringify({
        bash: { "*": { action: "deny", message } },
      }),
    );
    const faux = createFauxCore({ models: [{ id: "permission-test" }] });
    const services = await createAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        extensionFactories: [permissionExtension],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      model: faux.getModel(),
      sessionManager: SessionManager.inMemory(dir),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      session.setActiveToolsByName(["bash", "permission_probe"]);
      session.agent.streamFunction = faux.stream;
      const command = "touch should-not-exist";
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              "permission_probe",
              { toolName: "bash", input: { command } },
              { id: "probe" },
            ),
            fauxToolCall("bash", { command }, { id: "denied" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Finished."),
      ]);
      await session.agent.prompt("Check and attempt the command.");
      const results = session.agent.state.messages.filter((entry) => entry.role === "toolResult");
      const probe = results.find((entry) => entry.toolCallId === "probe");
      const denied = results.find((entry) => entry.toolCallId === "denied");
      assert.ok(probe);
      assert.ok(denied);
      assert.equal(probe.isError, false);
      const probeText = probe.content.find((entry) => entry.type === "text");
      assert.ok(probeText && probeText.type === "text");
      const prediction = JSON.parse(probeText.text);
      assert.equal(prediction.action, "deny");
      assert.equal(prediction.message, message);
      assert.equal(denied.isError, true);
      const deniedText = denied.content.find((entry) => entry.type === "text");
      assert.ok(deniedText && deniedText.type === "text");
      assert.match(deniedText.text, /permission: denied.*global bash\[\*\]/);
      assert.ok(deniedText.text.endsWith(`\n${message}`));
      await assert.rejects(fs.stat(path.join(dir, "should-not-exist")), { code: "ENOENT" });
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
