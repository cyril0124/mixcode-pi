// +---------------------------------------------------------------------------+
// |  tool-block extension                                                     |
// |  Hide selected tools from the model (active set).                         |
// |                                                                           |
// |  Config: <agentDir>/mpi-tool-block.json (global)                          |
// |          <cwd>/<CONFIG_DIR_NAME>/mpi-tool-block.json (project, trusted)   |
// |          session override (in-memory)                                     |
// |  Apply:  session_start + before_agent_start                               |
// |  UI:     /tool-block overlay (Layer: Global | Project | Session)          |
// +---------------------------------------------------------------------------+

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type ConfigLoadResult,
  deniedToolNames,
  EMPTY_TOOL_BLOCK_CONFIG,
  effectiveToolBlockConfig,
  loadToolBlockConfig,
  planActiveTools,
  projectToolBlockConfigPath,
  sameToolNames,
  type ToolBlockConfig,
  toolBlockConfigPath,
  toToolRefs,
  writeToolBlockConfig,
} from "./tool-block-core.js";
import { createToolBlockOverlay } from "./tool-block-overlay.js";

type CachedConfig =
  | { status: "missing"; path: string }
  | { status: "error"; path: string; error: string }
  | { status: "ok"; path: string; config: ToolBlockConfig };

type BrokenConfig = Extract<CachedConfig, { status: "error" }>;

function cacheFromLoad(loaded: ConfigLoadResult): CachedConfig {
  if (!loaded.ok) return { status: "error", path: loaded.path, error: loaded.error };
  if ("missing" in loaded && loaded.missing) return { status: "missing", path: loaded.path };
  return { status: "ok", path: loaded.path, config: loaded.config };
}

export default function toolBlockExtension(pi: ExtensionAPI) {
  let cached: CachedConfig = { status: "missing", path: "" };
  let cachedProject: CachedConfig | null = null;
  let projectPath = "";
  let sessionConfig: ToolBlockConfig | null = null;
  let previouslyRemoved: string[] = [];

  // Built-in packages live under agentDir/extensions instead of Pi package
  // settings, so the bundled skill root is announced explicitly.
  pi.on("resources_discover", () => ({
    skillPaths: [path.join(import.meta.dirname, "skills")],
  }));

  /**
   * Read both files. An untrusted project contributes no project layer, including
   * its parse errors.
   */
  function reload(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): CachedConfig {
    cached = cacheFromLoad(loadToolBlockConfig(toolBlockConfigPath(getAgentDir())));
    const trusted = ctx.isProjectTrusted();
    projectPath = trusted ? projectToolBlockConfigPath(ctx.cwd, CONFIG_DIR_NAME) : "";
    cachedProject = trusted ? cacheFromLoad(loadToolBlockConfig(projectPath)) : null;
    return cached;
  }

  function currentConfig(): ToolBlockConfig | null {
    return cached.status === "ok" ? cached.config : null;
  }

  function currentProjectConfig(): ToolBlockConfig | null {
    return cachedProject?.status === "ok" ? cachedProject.config : null;
  }

  /** The layer whose file failed to load, so the overlay can name it. */
  function brokenLayer(): BrokenConfig | null {
    if (cached.status === "error") return cached;
    return cachedProject?.status === "error" ? cachedProject : null;
  }

  function sync(): void {
    const tools = pi.getAllTools();
    const planned = planActiveTools({
      active: pi.getActiveTools(),
      registered: tools.map((tool) => tool.name),
      denied: deniedToolNames(
        effectiveToolBlockConfig({
          global: currentConfig(),
          project: currentProjectConfig(),
          session: sessionConfig,
        }),
      ),
      previouslyRemoved,
    });
    previouslyRemoved = planned.removed;
    if (sameToolNames(pi.getActiveTools(), planned.next)) return;
    pi.setActiveTools(planned.next);
  }

  // Reload both files. Session override lives in this closure and drops when the
  // extension instance is rebuilt (restart / /reload / new tab).
  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
    sync();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    reload(ctx);
    sync();
  });

  pi.registerCommand("tool-block", {
    description: "Hide tools from the model (global file, project file, or this session)",
    handler: async (_args, ctx) => {
      await openToolBlockOverlay(pi, ctx, {
        reload,
        setCached: (layer, next) => {
          if (layer === "project") cachedProject = next;
          else cached = next;
        },
        brokenLayer,
        getProjectPath: () => projectPath,
        getProject: () => currentProjectConfig(),
        getSession: () => sessionConfig,
        setSession: (next) => {
          sessionConfig = next;
        },
        sync,
      });
    },
  });
}

async function openToolBlockOverlay(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  hooks: {
    reload: (ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">) => CachedConfig;
    setCached: (layer: "global" | "project", next: CachedConfig) => void;
    brokenLayer: () => BrokenConfig | null;
    getProjectPath: () => string;
    getProject: () => ToolBlockConfig | null;
    getSession: () => ToolBlockConfig | null;
    setSession: (next: ToolBlockConfig) => void;
    sync: () => void;
  },
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Error: tool-block requires interactive UI", "error");
    return;
  }

  const snap = hooks.reload(ctx);
  const broken = snap.status === "error" ? snap : hooks.brokenLayer();
  if (broken) {
    ctx.ui.notify(`Error: tool-block config error (${broken.path}): ${broken.error}`, "error");
    return;
  }

  const agentDir = getAgentDir();
  const configPath = toolBlockConfigPath(agentDir);
  const projectPath = hooks.getProjectPath();
  const tools = toToolRefs(pi.getAllTools());
  const initial = snap.status === "ok" ? snap.config : EMPTY_TOOL_BLOCK_CONFIG;
  const session = hooks.getSession();

  await ctx.ui.custom(
    (tui, theme, _kb, done) =>
      createToolBlockOverlay({
        theme,
        requestRender: () => tui.requestRender(),
        done: () => done(undefined),
        tools,
        initial,
        project: hooks.getProject(),
        projectPath: projectPath || undefined,
        session,
        initialLayer: session ? "session" : "global",
        configPath,
        getActiveNames: () => pi.getActiveTools(),
        persist: (next, layer) => {
          if (layer === "session") {
            hooks.setSession(next);
            hooks.sync();
            return { ok: true, config: next };
          }
          const written = writeToolBlockConfig(
            layer === "project" ? projectPath : configPath,
            next,
          );
          if (!written.ok)
            return { ok: false, error: `Error: failed to write ${written.path}: ${written.error}` };
          hooks.setCached(layer, { status: "ok", path: written.path, config: written.config });
          hooks.sync();
          return { ok: true, config: written.config };
        },
        onError: (message) => ctx.ui.notify(message, "error"),
        getMaxVisible: () => Math.max(6, Math.floor(tui.terminal.rows * 0.8) - 2),
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "78%",
        maxHeight: "80%",
        margin: 1,
      },
    },
  );
}
