import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type JsonObject,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import stuckGuardExtension from "../../pi-packages/mpi-stuck-guard/index.js";

export interface LoopProbeCall {
  toolName?: string;
  input: JsonObject;
}

/** Run real SDK tool preflight and continuation with an offline provider and isolated config. */
export async function withLoopSession(
  config: unknown,
  run: (fixture: {
    directory: string;
    session: AgentSession;
    executed: JsonObject[];
    prompt: (calls: readonly LoopProbeCall[]) => Promise<void>;
    configure: (config: unknown) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stuck-loop-session-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session: AgentSession | undefined;
  try {
    await fs.writeFile(path.join(dir, "mpi-stuck-guard.json"), JSON.stringify(config));
    const executed: JsonObject[] = [];
    const services = await createAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        extensionFactories: [
          stuckGuardExtension,
          (pi) => {
            for (const name of ["loop_probe", "other_probe"]) {
              pi.registerTool({
                name,
                label: name,
                description: "Record a probe payload for offline loop protection checks.",
                parameters: Type.Object({ payload: Type.Record(Type.String(), Type.Unknown()) }),
                async execute(_id, input) {
                  executed.push(input.payload as JsonObject);
                  return { content: [{ type: "text", text: "Probe recorded." }], details: {} };
                },
              });
            }
          },
        ],
      },
    });
    const faux = fauxProvider({ provider: "stuck-loop-session", models: [{ id: "offline" }] });
    services.modelRuntime.registerNativeProvider(faux.provider);
    const created = await createAgentSessionFromServices({
      services,
      model: faux.getModel(),
      sessionManager: SessionManager.inMemory(dir),
    });
    const activeSession = created.session;
    session = activeSession;
    await activeSession.bindExtensions({ mode: "print" });
    let nextId = 0;
    await run({
      directory: dir,
      session: activeSession,
      executed,
      configure: (next) =>
        fs.writeFile(path.join(dir, "mpi-stuck-guard.json"), JSON.stringify(next)),
      prompt: async (calls) => {
        faux.setResponses([
          ...calls.map((call) =>
            fauxAssistantMessage(
              fauxToolCall(
                call.toolName ?? "loop_probe",
                call.toolName === "read" ? call.input : { payload: call.input },
                { id: `probe-${++nextId}` },
              ),
              { stopReason: "toolUse" },
            ),
          ),
          fauxAssistantMessage("Probe sequence finished."),
        ]);
        await activeSession.prompt("Execute the probe sequence.");
      },
    });
  } finally {
    try {
      if (session) {
        try {
          // Extension-owned session state is retired before the runner is invalidated.
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          session.dispose();
        }
      }
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
