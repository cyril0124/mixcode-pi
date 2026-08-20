// +---------------------------------------------------------------------------+
// |  tool-block extension                                                     |
// |  Hide selected tools from the model (active set).                         |
// |                                                                           |
// |  Config: <agentDir>/mpi-tool-block.json (global) + session overlay      |
// |  Apply:  session_start + before_agent_start                               |
// |  UI:     /tool-block overlay (Layer: Global | Session)                    |
// +---------------------------------------------------------------------------+
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  deniedToolNames,
  effectiveToolBlockConfig,
  loadToolBlockConfig,
  planActiveTools,
  sameToolNames,
  toToolRefs,
  toolBlockConfigPath,
  writeToolBlockConfig,
  type ConfigLoadResult,
  type ToolBlockConfig,
} from "./tool-block-core.js";
import { createToolBlockOverlay } from "./tool-block-overlay.js";

const EMPTY_CONFIG: ToolBlockConfig = { enabled: true, hidden: [] };

type CachedConfig =
  | { status: "missing"; path: string }
  | { status: "error"; path: string; error: string }
  | { status: "ok"; path: string; config: ToolBlockConfig };

function cacheFromLoad(loaded: ConfigLoadResult): CachedConfig {
  if (!loaded.ok) return { status: "error", path: loaded.path, error: loaded.error };
  if ("missing" in loaded && loaded.missing) return { status: "missing", path: loaded.path };
  return { status: "ok", path: loaded.path, config: loaded.config };
}

export default function toolBlockExtension(pi: ExtensionAPI) {
  let cached: CachedConfig = { status: "missing", path: "" };
  let sessionConfig: ToolBlockConfig | null = null;
  let previouslyRemoved: string[] = [];

  function reload(): CachedConfig {
    cached = cacheFromLoad(loadToolBlockConfig(getAgentDir()));
    return cached;
  }

  function currentConfig(): ToolBlockConfig | null {
    return cached.status === "ok" ? cached.config : null;
  }

  function sync(): void {
    const tools = pi.getAllTools();
    const planned = planActiveTools({
      active: pi.getActiveTools(),
      registered: tools.map((tool) => tool.name),
      denied: deniedToolNames(effectiveToolBlockConfig(currentConfig(), sessionConfig)),
      previouslyRemoved,
    });
    previouslyRemoved = planned.removed;
    if (sameToolNames(pi.getActiveTools(), planned.next)) return;
    pi.setActiveTools(planned.next);
  }

  // Reload the global file only. Session override lives in this closure and
  // drops when the extension instance is rebuilt (restart / /reload / new tab).
  pi.on("session_start", () => {
    reload();
    sync();
  });

  pi.on("before_agent_start", () => {
    reload();
    sync();
  });

  pi.registerCommand("tool-block", {
    description: "Hide tools from the model (global file or this session)",
    handler: async (_args, ctx) => {
      await openToolBlockOverlay(pi, ctx, {
        reload,
        setCached: (next) => {
          cached = next;
        },
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
    reload: () => CachedConfig;
    setCached: (next: CachedConfig) => void;
    getSession: () => ToolBlockConfig | null;
    setSession: (next: ToolBlockConfig) => void;
    sync: () => void;
  },
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("tool-block requires interactive UI", "error");
    return;
  }

  const snap = hooks.reload();
  if (snap.status === "error") {
    ctx.ui.notify(`tool-block config error (${snap.path}): ${snap.error}`, "error");
    return;
  }

  const agentDir = getAgentDir();
  const configPath = toolBlockConfigPath(agentDir);
  const tools = toToolRefs(pi.getAllTools());
  const initial = snap.status === "ok" ? snap.config : EMPTY_CONFIG;
  const session = hooks.getSession();

  await ctx.ui.custom(
    (tui, theme, _kb, done) =>
      createToolBlockOverlay({
        theme,
        requestRender: () => tui.requestRender(),
        done: () => done(undefined),
        tools,
        initial,
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
          const written = writeToolBlockConfig(agentDir, next);
          if (!written.ok) return { ok: false, error: `Failed to write ${written.path}: ${written.error}` };
          hooks.setCached({ status: "ok", path: written.path, config: written.config });
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
