import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionFactory,
  getAgentDir,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { configPath, loadConfigFile, projectConfigPath, setConfigEnabled } from "./config.js";
import { CommandRouter } from "./router.js";

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Error:") ? message : `Error: mpi-command-router: ${message}`;
}

const USAGE = "Error: Usage: /command-router [on|off] [--global|--project]";

const SUBCOMMANDS = [
  {
    value: "status",
    label: "status",
    description: "Show both layers and the effective state",
  },
  { value: "on", label: "on", description: "Enable routing" },
  { value: "off", label: "off", description: "Disable routing" },
  { value: "--global", label: "--global", description: "Touch only the user layer" },
  { value: "--project", label: "--project", description: "Touch only the repository layer" },
];

/** One layer's contribution to the status line; an inapplicable layer cannot block routing. */
interface LayerSummary {
  text: string;
  enabled: boolean;
}

async function summarizeLayer(filename: string, applicable: boolean): Promise<LayerSummary> {
  if (!applicable) return { text: "ignored (project not trusted)", enabled: true };
  const config = await loadConfigFile(filename);
  if (!config) return { text: "no config file", enabled: true };
  const count = Object.keys(config.routes).length;
  return {
    text: `${config.enabled ? "on" : "off"} (${count} route${count === 1 ? "" : "s"})`,
    enabled: config.enabled,
  };
}

/** Render one layer's write result, so a two-layer toggle reads as a single status line. */
function describeWrite(
  layer: string,
  enabled: boolean,
  created: boolean,
  filename: string,
): string {
  const state = enabled ? "enabled" : "disabled";
  const note = created ? " (file created with no routes)" : "";
  return `${layer} ${state}${note} — ${filename}`;
}

function chooseSubcommand(prefix: string) {
  const trimmed = prefix.trimStart();
  const space = trimmed.search(/\s/);
  // Flags select a layer, so they follow a subcommand rather than replacing it.
  const items =
    space >= 0 ? SUBCOMMANDS.filter((item) => item.value.startsWith("--")) : SUBCOMMANDS;
  const token = space >= 0 ? trimmed.slice(space).trimStart() : trimmed;
  const filtered = items.filter((item) => item.value.startsWith(token));
  return filtered.length > 0 ? filtered : null;
}

const commandRouterExtension: ExtensionFactory = (pi) => {
  const agentDir = getAgentDir();
  const router = new CommandRouter(agentDir, CONFIG_DIR_NAME);

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

  pi.registerCommand("command-router", {
    description: "Show command routing status; on|off [--global|--project]",
    ...({
      argumentHint: "[on|off|status] [--global|--project]",
    } as Record<string, unknown>),
    getArgumentCompletions: chooseSubcommand,
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const words = tokens.filter((token) => !token.startsWith("--"));
      const flags = tokens.filter((token) => token.startsWith("--"));
      const action = (words[0] ?? "status").toLowerCase();
      const globalPath = configPath(agentDir);
      const projectPath = projectConfigPath(ctx.cwd, CONFIG_DIR_NAME);
      const trusted = ctx.isProjectTrusted();
      const onlyGlobal = flags.includes("--global");
      const onlyProject = flags.includes("--project");
      const unknownFlag = flags.some((flag) => flag !== "--global" && flag !== "--project");

      // Both layers and only "status" describe the whole state, so a layer flag is invalid there.
      const invalid =
        words.length > 1 ||
        unknownFlag ||
        (onlyGlobal && onlyProject) ||
        !["status", "on", "off"].includes(action) ||
        (action === "status" && flags.length > 0);
      if (invalid) {
        ctx.ui.notify(USAGE, "error");
        return;
      }

      try {
        if (action === "status") {
          const globalLayer = await summarizeLayer(globalPath, true);
          const projectLayer = await summarizeLayer(projectPath, trusted);
          const effective = globalLayer.enabled && projectLayer.enabled;
          const state = effective ? "on" : "off";
          ctx.ui.notify(
            `Routing ${state}: global ${globalLayer.text} — ${globalPath}; project ${projectLayer.text} — ${projectPath}`,
          );
          return;
        }

        const enabled = action === "on";
        const reports: string[] = [];

        if (!onlyProject) {
          const { created } = await setConfigEnabled(globalPath, enabled);
          reports.push(describeWrite("global", enabled, created, globalPath));
        }

        if (!onlyGlobal) {
          // The default covers both layers but writes a project layer only when it already
          // exists, so a toggle never leaves an untracked config in a repository without routes.
          if (!trusted) {
            if (onlyProject) throw new Error("Error: --project requires a trusted project");
            reports.push("project skipped (project not trusted)");
          } else if (onlyProject || (await loadConfigFile(projectPath))) {
            const { created } = await setConfigEnabled(projectPath, enabled);
            reports.push(describeWrite("project", enabled, created, projectPath));
          } else {
            reports.push("project skipped (no config file)");
          }
        }

        if (enabled) {
          // Routing needs every applicable layer enabled, so name any layer that is still off.
          const globalLayer = await summarizeLayer(globalPath, true);
          const projectLayer = await summarizeLayer(projectPath, trusted);
          const blocked = [
            ...(globalLayer.enabled ? [] : [`global layer ${globalLayer.text}`]),
            ...(projectLayer.enabled ? [] : [`project layer ${projectLayer.text}`]),
          ];
          if (blocked.length > 0) reports.push(`still off: ${blocked.join(", ")}`);
        }
        ctx.ui.notify(`Routing ${action}: ${reports.join("; ")}`);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
};

export default commandRouterExtension;
