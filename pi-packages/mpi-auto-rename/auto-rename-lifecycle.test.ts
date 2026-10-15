import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createAuxModelRegistry } from "../../test/helpers/aux-model-registry.js";
import autoRename from "./index.js";

test("/auto-rename does not access the old session after newSession replaces it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-auto-rename-lifecycle-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempDir;
  let host: AgentSessionRuntime | undefined;

  try {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { runtime: modelRuntime, registry } = await createAuxModelRegistry({
      models: [{ provider: "rename-test", id: "deferred" }],
      complete: async () => {
        entered.resolve();
        await release.promise;
        throw new Error("delayed model failure");
      },
    });
    const model = registry.find("rename-test", "deferred");
    assert.ok(model);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir: tempDir,
        modelRuntime,
        resourceLoaderOptions: {
          extensionFactories: [autoRename],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    host = await createAgentSessionRuntime(createRuntime, {
      cwd: tempDir,
      agentDir: tempDir,
      sessionManager: SessionManager.create(tempDir),
    });
    await host.session.bindExtensions({});

    const notices: string[] = [];
    const widgets: unknown[] = [];
    host.session.extensionRunner.setUIContext(
      {
        notify: (message: string) => notices.push(message),
        setWidget: (_key: string, widget: unknown) => widgets.push(widget),
      } as unknown as ExtensionUIContext,
      "tui",
    );
    host.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Review the authentication flow" }],
      timestamp: Date.now(),
    });

    assert.ok(host.session.extensionRunner.getCommand("auto-rename"));
    await host.session.prompt("/auto-rename");
    await entered.promise;
    assert.equal(typeof widgets[0], "function");

    const oldSession = host.session.sessionManager;
    const replacement = await host.newSession();
    assert.equal(replacement.cancelled, false);
    assert.notEqual(host.session.sessionManager, oldSession);

    release.resolve();
    await setImmediate();
    assert.equal(oldSession.getSessionName(), undefined);
    assert.equal(host.session.sessionManager.getSessionName(), undefined);
    assert.equal(widgets.at(-1), undefined);
    assert.deepEqual(notices, []);
  } finally {
    await host?.dispose();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
