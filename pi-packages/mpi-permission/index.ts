// +---------------------------------------------------------------------------+
// |  permission extension                                                     |
// |  Gate tool calls with allow / ask / deny rules.                           |
// |                                                                           |
// |  Config: <agentDir>/mpi-permission.json (global)                        |
// |          <cwd>/<CONFIG_DIR_NAME>/mpi-permission.json (project, trusted) |
// |          in-memory session rules (ask "always" grants, overlay edits)     |
// |  Gate:   tool_call -> evaluate -> allow / ask dialog / deny block         |
// |  UI:     /permission overlay (Layer: Global | Project | Session)          |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  addRule,
  createDoomLoopTracker,
  doomLoopAction,
  emptyPermissionConfig,
  EXTERNAL_DIRECTORY_KEY,
  evaluateToolCallDecisions,
  hasAnyRules,
  loadPermissionConfig,
  permissionConfigPath,
  projectPermissionConfigPath,
  writePermissionConfig,
  type ConfigLoadResult,
  type LayeredConfig,
  type PermissionConfig,
  type PermissionDecision,
  type PermissionSource,
} from "./permission-core.js";
import { createPermissionOverlay } from "./permission-overlay.js";

type CachedConfig =
  | { status: "missing"; path: string }
  | { status: "error"; path: string; error: string }
  | { status: "ok"; path: string; config: PermissionConfig };

function cacheFromLoad(loaded: ConfigLoadResult): CachedConfig {
  if (!loaded.ok) return { status: "error", path: loaded.path, error: loaded.error };
  if ("missing" in loaded && loaded.missing) return { status: "missing", path: loaded.path };
  return { status: "ok", path: loaded.path, config: loaded.config };
}

const SUBJECT_PREVIEW_MAX = 200;

function preview(text: string): string {
  return text.length > SUBJECT_PREVIEW_MAX ? `${text.slice(0, SUBJECT_PREVIEW_MAX)}…` : text;
}

function describeSource(source: PermissionSource): string {
  return `${source.layer} ${source.tool}[${source.pattern}] matched "${preview(source.subject)}"`;
}

function existingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return false;
    throw err;
  }
}

type SuggestedRule = { tool: string; pattern: string };

/**
 * Session "always" grant patterns suggested in the ask dialog.
 * Bash grants the first one or two command words plus ` *`; path-like and
 * pattern subjects grant the exact subject; an existing external directory
 * needs exact + contents rules. Doom-loop asks get no "always" option.
 */
function suggestAlwaysRules(source: PermissionSource, toolName: string): SuggestedRule[] {
  if (source.kind === "doom_loop") return [];
  if (source.kind === "external_directory") {
    if (existingDirectory(source.subject)) {
      return [
        { tool: EXTERNAL_DIRECTORY_KEY, pattern: source.subject },
        { tool: EXTERNAL_DIRECTORY_KEY, pattern: `${source.subject}/*` },
      ];
    }
    return [{ tool: EXTERNAL_DIRECTORY_KEY, pattern: `${path.dirname(source.subject)}/*` }];
  }
  if (toolName === "bash") {
    // `git status*` (no space) also matches the bare `git status` form.
    const words = source.subject.split(" ");
    const prefix = words.slice(0, Math.min(2, words.length)).join(" ");
    return [{ tool: toolName, pattern: `${prefix}*` }];
  }
  return [{ tool: toolName, pattern: source.subject }];
}

export default function permissionExtension(pi: ExtensionAPI) {
  const home = process.env.HOME || os.homedir();
  let cachedGlobal: CachedConfig = { status: "missing", path: permissionConfigPath(getAgentDir()) };
  let cachedProject: CachedConfig | null = null;
  let sessionConfig: PermissionConfig = emptyPermissionConfig();
  const doomTracker = createDoomLoopTracker();
  let doomGuardActive = false;

  function reload(cwd: string): void {
    cachedGlobal = cacheFromLoad(loadPermissionConfig(permissionConfigPath(getAgentDir())));
    cachedProject = cacheFromLoad(
      loadPermissionConfig(projectPermissionConfigPath(cwd, CONFIG_DIR_NAME)),
    );
  }

  function ensureLoaded(cwd: string): void {
    if (cachedProject === null) reload(cwd);
  }

  /** Broken config files fail closed: every tool call blocks until fixed. */
  function configError(trusted: boolean): CachedConfig | null {
    if (cachedGlobal.status === "error") return cachedGlobal;
    if (trusted && cachedProject?.status === "error") return cachedProject;
    return null;
  }

  function buildLayers(trusted: boolean): LayeredConfig[] {
    const layers: LayeredConfig[] = [];
    if (cachedGlobal.status === "ok") layers.push({ layer: "global", config: cachedGlobal.config });
    if (trusted && cachedProject?.status === "ok") {
      layers.push({ layer: "project", config: cachedProject.config });
    }
    if (hasAnyRules(sessionConfig)) layers.push({ layer: "session", config: sessionConfig });
    return layers;
  }

  // Session rules live in this closure and drop when the extension instance
  // is rebuilt (restart, /reload, new tab).
  pi.on("session_start", (_event, ctx) => reload(ctx.cwd));
  pi.on("before_agent_start", (_event, ctx) => reload(ctx.cwd));

  pi.on("tool_call", async (event, ctx) => {
    ensureLoaded(ctx.cwd);
    const trusted = ctx.isProjectTrusted();
    const broken = configError(trusted);
    if (broken && broken.status === "error") {
      return {
        block: true,
        reason: `permission: config invalid, failing closed (${broken.path}): ${broken.error}`,
      };
    }

    const layers = buildLayers(trusted);
    const doom = doomLoopAction(layers);
    const nextDoomGuardActive = doom !== null && doom.action !== "allow";
    if (nextDoomGuardActive && !doomGuardActive) doomTracker.reset();
    doomGuardActive = nextDoomGuardActive;
    if (layers.length === 0) return undefined; // inert: no config anywhere

    const input = event.input as Record<string, unknown>;
    // An explicit "allow" disables the guard just like an absent setting.
    const doomCount = doomGuardActive ? doomTracker.record(event.toolName, input) : 0;
    const decisions = evaluateToolCallDecisions({
      layers,
      toolName: event.toolName,
      input,
      cwd: ctx.cwd,
      home,
      doomCount,
    });

    const denied = decisions.find((candidate) => candidate.action === "deny");
    if (denied) {
      const detail = denied.source ? describeSource(denied.source) : "denied";
      return { block: true, reason: `permission: denied — ${detail}` };
    }
    const asks = decisions.filter((candidate) => candidate.action === "ask");
    if (asks.length === 0) return undefined;
    return askUser(asks, event.toolName, ctx);
  });

  async function askUser(
    decisions: readonly PermissionDecision[],
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const sources = decisions.map((decision) => decision.source!); // ask decisions always carry a source
    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          `permission: "ask" required — ${sources.map(describeSource).join("; ")}; ` +
          "no interactive UI is available, add an allow rule or run interactively",
      };
    }
    const suggestions = sources.some((source) => source.kind === "doom_loop")
      ? []
      : sources
          .flatMap((source) => suggestAlwaysRules(source, toolName))
          .filter(
            (rule, index, list) =>
              list.findIndex(
                (candidate) => candidate.tool === rule.tool && candidate.pattern === rule.pattern,
              ) === index,
          );
    const ALLOW_ONCE = "Allow once";
    const REJECT = "Reject";
    const always =
      suggestions.length === 0
        ? null
        : suggestions.length === 1
          ? `Always allow: ${suggestions[0]!.tool}[${suggestions[0]!.pattern}]`
          : `Always allow these ${suggestions.length} rules`;
    const options = always ? [ALLOW_ONCE, always, REJECT] : [ALLOW_ONCE, REJECT];
    const doom = sources.find((source) => source.kind === "doom_loop");
    const details = sources
      .filter((source) => source.kind !== "doom_loop")
      .map(
        (source) =>
          `  ${preview(source.subject)}\n\n  rule: ${source.layer} ${source.tool}[${source.pattern}]`,
      )
      .join("\n\n");
    const title = doom
      ? `Permission: ${toolName} repeated with identical input\n\n  ${preview(doom.subject)}\n${details ? `\n${details}\n` : ""}`
      : `Permission: ${toolName}\n\n${details}\n`;
    // The tool row keeps counting from tool_execution_start while the dialog
    // is open even though nothing has spawned yet; make the wait explicit.
    ctx.ui.setWorkingMessage("waiting for permission approval…");
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(title, options, { signal: ctx.signal });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        block: true,
        reason: `permission: approval dialog failed, denying — ${detail}`,
      };
    } finally {
      ctx.ui.setWorkingMessage();
    }
    if (choice === ALLOW_ONCE) return undefined;
    if (choice === always) {
      for (const suggestion of suggestions) {
        sessionConfig = addRule(sessionConfig, suggestion.tool, suggestion.pattern, "allow");
      }
      return undefined;
    }
    return {
      block: true,
      reason: `permission: rejected by user — ${sources.map(describeSource).join("; ")}`,
    };
  }

  pi.registerCommand("permission", {
    description: "Edit tool permission rules (allow / ask / deny)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("permission requires interactive UI", "error");
        return;
      }
      reload(ctx.cwd);
      const trusted = ctx.isProjectTrusted();
      const broken = configError(trusted);
      if (broken && broken.status === "error") {
        ctx.ui.notify(`permission config error (${broken.path}): ${broken.error}`, "error");
        return;
      }
      const globalPath = cachedGlobal.path;
      const projectPath = cachedProject!.path;
      await ctx.ui.custom(
        (tui, theme, _kb, done) =>
          createPermissionOverlay({
            theme,
            requestRender: () => tui.requestRender(),
            done: () => done(undefined),
            trusted,
            paths: { global: globalPath, project: projectPath },
            knownKeys: [
              "*",
              EXTERNAL_DIRECTORY_KEY,
              ...[...new Set(pi.getAllTools().map((tool) => tool.name))].sort(),
            ],
            initial: {
              global: cachedGlobal.status === "ok" ? cachedGlobal.config : emptyPermissionConfig(),
              project:
                cachedProject!.status === "ok" ? cachedProject!.config : emptyPermissionConfig(),
              session: sessionConfig,
            },
            persist: (config, layer) => {
              if (layer === "session") {
                sessionConfig = config;
                return { ok: true };
              }
              if (layer === "project" && !trusted) {
                return { ok: false, error: "project is not trusted; project rules are ignored" };
              }
              const filePath = layer === "global" ? globalPath : projectPath;
              const written = writePermissionConfig(filePath, config);
              if (!written.ok) {
                return { ok: false, error: `Failed to write ${written.path}: ${written.error}` };
              }
              const next: CachedConfig = { status: "ok", path: filePath, config };
              if (layer === "global") cachedGlobal = next;
              else cachedProject = next;
              return { ok: true };
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
    },
  });
}
