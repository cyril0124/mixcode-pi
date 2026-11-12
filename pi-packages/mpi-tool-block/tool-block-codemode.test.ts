import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import toolBlockExtension from "./index.js";

test("codemode cannot execute a hidden tool while other nested tools still run", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-block-codemode-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const executed: string[] = [];
  try {
    await fs.writeFile(
      path.join(dir, "mpi-tool-block.json"),
      JSON.stringify({ enabled: true, hidden: ["blocked_probe"] }),
    );
    const faux = createFauxCore({ models: [{ id: "tool-block-test" }] });
    const services = await createAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        extensionFactories: [
          toolBlockExtension,
          createCodemodeExtension(),
          (pi) => {
            for (const name of ["blocked_probe", "allowed_probe"]) {
              pi.registerTool({
                name,
                label: name,
                description: `Record ${name} calls to verify nested blocking.`,
                exposure: "codemode",
                parameters: Type.Object({ value: Type.String() }),
                async execute(_id, input) {
                  executed.push(`${name}:${input.value}`);
                  return { content: [{ type: "text", text: `${name} executed` }], details: {} };
                },
              });
            }
          },
        ],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      model: faux.getModel(),
      sessionManager: SessionManager.inMemory(dir),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      session.setActiveToolsByName(["codemode"]);
      session.agent.streamFunction = faux.stream;
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "codemode",
            {
              code: `
                try {
                  const result = await tools.blocked_probe({ value: "nested" });
                  text(\`unexpected:\${result}\`);
                } catch (error) {
                  text(\`blocked:\${error.message}\`);
                }
                const allowed = await tools.allowed_probe({ value: "nested" });
                text(\`allowed:\${allowed}\`);
              `,
            },
            { id: "nested-tools" },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Nested blocking check finished."),
      ]);

      await session.agent.prompt("Run the blocked and allowed nested probes.");
      assert.deepEqual(executed, ["allowed_probe:nested"]);

      const codemodeResult = session.agent.state.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "nested-tools",
      );
      assert.ok(codemodeResult && codemodeResult.role === "toolResult");
      assert.equal(codemodeResult.isError, false);
      assert.deepEqual(
        codemodeResult.nestedCalls?.calls.map((call) => [call.name, call.status]),
        [
          ["blocked_probe", "error"],
          ["allowed_probe", "ok"],
        ],
      );
      const output = codemodeResult.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      assert.match(output, /tool-block:.*blocked_probe/);
      assert.match(output, /allowed:allowed_probe executed/);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
