import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionFactory,
  getAgentDir,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { CommandRouter } from "./router.js";

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Error:") ? message : `Error: mpi-command-router: ${message}`;
}

const commandRouterExtension: ExtensionFactory = (pi) => {
  const router = new CommandRouter(getAgentDir(), CONFIG_DIR_NAME);

  // Built-in packages live under agentDir/extensions instead of Pi package
  // settings, so the bundled skill root is announced explicitly.
  pi.on("resources_discover", () => ({
    skillPaths: [path.join(import.meta.dirname, "skills")],
  }));

  pi.on("session_start", async (_event, ctx) => {
    try {
      await router.prepare("", { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    } catch (error) {
      // A bad config remains fail-closed at tool_call, even if lifecycle errors are nonfatal.
      ctx.ui.notify(errorMessage(error), "error");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    try {
      event.input.command = await router.prepare(event.input.command, {
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
    } catch (error) {
      return { block: true, reason: errorMessage(error) };
    }
  });
};

export default commandRouterExtension;
