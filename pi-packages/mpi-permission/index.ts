// +---------------------------------------------------------------------------+
// |  permission extension                                                     |
// |  Gate tool calls with allow / ask / deny rules.                           |
// |                                                                           |
// |  Config: <agentDir>/mpi-permission.json (global)                        |
// |          <cwd>/<CONFIG_DIR_NAME>/mpi-permission.json (project, trusted) |
// |          in-memory session rules (ask "always" grants, overlay edits)     |
// |  Gate:   tool_call -> evaluate -> allow / ask dialog / deny block         |
// |  UI:     /permission [list [scope] | probe [on|off]]                      |
// |          bare /permission opens the overlay (Global | Project | Session)  |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  addRule,
  emptyPermissionConfig,
  EXTERNAL_DIRECTORY_KEY,
  evaluateToolCallDecisions,
  hasAnyRules,
  loadPermissionConfig,
  permissionConfigPath,
  projectPermissionConfigPath,
  stricterPermissionDecision,
  writePermissionConfig,
  type ConfigLoadResult,
  type LayeredConfig,
  type PermissionAction,
  type PermissionConfig,
  type PermissionDecision,
  type PermissionLayer,
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
const PERMISSION_PROBE_NAME = "permission_probe";

const permissionProbeSchema = Type.Object({
  toolName: Type.String({ description: "Registered tool to evaluate" }),
  input: Type.Record(Type.String(), Type.Unknown(), {
    description: "Arguments that would be passed to the registered tool",
  }),
});

function invalidTargetInputResult(toolName: string, input: unknown, schema: unknown) {
  if (Value.Check(schema as Parameters<typeof Value.Check>[0], input)) return null;
  const errors = [...Value.Errors(schema as Parameters<typeof Value.Errors>[0], input)].map(
    (error) => ({
      path: "path" in error ? error.path : "",
      message: error.message,
    }),
  );
  return {
    ok: false as const,
    error: "invalid_target_input" as const,
    toolName,
    errors,
  };
}

function permissionProbeResult(
  toolName: string,
  input: Record<string, unknown>,
  layers: readonly LayeredConfig[],
  cwd: string,
  home: string,
) {
  const decisions = evaluateToolCallDecisions({ layers, toolName, input, cwd, home });
  const decision = decisions.reduce(
    (current, candidate) => stricterPermissionDecision(current, candidate),
    { action: "allow" as const },
  );
  return {
    ok: true as const,
    toolName,
    inputValid: true as const,
    action: decision.action,
    ...(decision.message !== undefined ? { message: decision.message } : {}),
    wouldAllow: decision.action === "allow",
    wouldAsk: decision.action === "ask",
    wouldBlock: decision.action === "deny",
    sources: decisions.flatMap((candidate) => (candidate.source ? [candidate.source] : [])),
  };
}

function preview(text: string): string {
  return text.length > SUBJECT_PREVIEW_MAX ? `${text.slice(0, SUBJECT_PREVIEW_MAX)}…` : text;
}

function describeSource(source: PermissionSource): string {
  return `${source.layer} ${source.tool}[${source.pattern}] matched "${preview(source.subject)}"`;
}

const PERMISSION_USAGE =
  "Error: Usage: /permission [list [all|global|project|session] | probe [on|off]]";
const LIST_SCOPES: ReadonlyArray<PermissionLayer | "all"> = ["all", "global", "project", "session"];

const SUBCOMMAND_ITEMS: AutocompleteItem[] = [
  { value: "list", label: "list", description: "Show the rules that apply here" },
  { value: "probe", label: "probe", description: "Enable or disable the permission_probe tool" },
];
/** One candidate for the second token, without the leading subcommand. */
type ArgumentOption = { token: string; description: string };

const LIST_SCOPE_OPTIONS: ArgumentOption[] = LIST_SCOPES.map((scope) => ({
  token: scope,
  description: scope === "all" ? "Every layer (default)" : `${scope} layer only`,
}));
const ON_OFF_OPTIONS: ArgumentOption[] = [
  { token: "on", description: "Enable permission_probe (default)" },
  { token: "off", description: "Disable permission_probe" },
];

/**
 * Completions for the `/permission` dispatcher's two-token grammar.
 *
 * Pi replaces the whole argument text with `item.value`, so second-token
 * candidates must carry the subcommand they belong to ("list global", not
 * "global") or accepting one would drop the subcommand.
 */
function permissionArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  // Keep the trailing space: it marks the token boundary that switches to the
  // second-token candidates ("list " vs "list").
  const trimmed = prefix.trimStart().toLowerCase();
  const space = trimmed.indexOf(" ");
  if (space < 0) {
    const items = SUBCOMMAND_ITEMS.filter((item) => item.value.startsWith(trimmed));
    return items.length > 0 ? items : null;
  }
  const head = trimmed.slice(0, space);
  const tail = trimmed.slice(space + 1).trim();
  const options = head === "list" ? LIST_SCOPE_OPTIONS : head === "probe" ? ON_OFF_OPTIONS : [];
  const items = options
    .filter((option) => option.token.startsWith(tail))
    .map((option) => ({
      value: `${head} ${option.token}`,
      label: option.token,
      description: option.description,
    }));
  return items.length > 0 ? items : null;
}

/** One layer as shown by `/permission list`. */
type LayerView = {
  layer: PermissionLayer;
  /** Config file path, or the in-memory note for session rules. */
  location: string;
  /** Trailing qualifier: not created, untrusted, or a load error. */
  note: string;
  rules: Array<{ tool: string; pattern: string; action: PermissionAction; message?: string }>;
};

function cachedLayerView(cached: CachedConfig, layer: PermissionLayer): LayerView {
  if (cached.status === "error") {
    return { layer, location: cached.path, note: ` (config error: ${cached.error})`, rules: [] };
  }
  if (cached.status === "missing") {
    return { layer, location: cached.path, note: " (not created)", rules: [] };
  }
  const rules = cached.config.entries.flatMap((entry) =>
    entry.rules.map((rule) => ({
      tool: entry.tool,
      pattern: rule.pattern,
      action: rule.action,
      ...(rule.message === undefined ? {} : { message: rule.message }),
    })),
  );
  return { layer, location: cached.path, note: "", rules };
}

/** Human-only rule overview; the text is rendered by `ctx.ui.notify`. */
function formatPermissionList(views: readonly LayerView[]): string {
  const lines: string[] = [];
  for (const view of views) {
    lines.push(`${view.layer} · ${view.location}${view.note}`);
    if (view.rules.length === 0) {
      lines.push("  (no rules)");
      continue;
    }
    const toolWidth = Math.max(...view.rules.map((rule) => rule.tool.length));
    for (const rule of view.rules) {
      const message = rule.message === undefined ? "" : `  "${rule.message}"`;
      lines.push(
        `  ${rule.tool.padEnd(toolWidth)}  ${rule.action.padEnd(5)}  ${rule.pattern}${message}`,
      );
    }
  }
  return lines.join("\n");
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
 * needs exact + contents rules.
 */
function suggestAlwaysRules(source: PermissionSource, toolName: string): SuggestedRule[] {
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

  // Built-in packages live under agentDir/extensions instead of Pi package settings.
  pi.on("resources_discover", () => ({
    skillPaths: [path.join(import.meta.dirname, "skills")],
  }));

  // Session rules live in this closure and drop when the extension instance
  // is rebuilt (restart, /reload, new tab).
  pi.on("session_start", (event, ctx) => {
    reload(ctx.cwd);
    if (event.reason === "startup") {
      const active = pi.getActiveTools();
      const next = active.filter((name) => name !== PERMISSION_PROBE_NAME);
      if (next.length !== active.length) pi.setActiveTools(next);
    }
  });
  pi.on("before_agent_start", (_event, ctx) => reload(ctx.cwd));

  pi.registerTool({
    name: PERMISSION_PROBE_NAME,
    label: "Permission Probe",
    description:
      "Check this package's permission rules for a registered tool call: allowed, approval required, or blocked. " +
      "Validates the target input against its registered schema without executing it; does not predict other extensions' guards.",
    parameters: permissionProbeSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = pi.getAllTools().find((tool) => tool.name === params.toolName);
      if (!target) {
        const result = {
          ok: false as const,
          error: "unknown_tool" as const,
          toolName: params.toolName,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }
      const invalid = invalidTargetInputResult(params.toolName, params.input, target.parameters);
      if (invalid) {
        return {
          content: [{ type: "text", text: JSON.stringify(invalid, null, 2) }],
          details: invalid,
        };
      }
      ensureLoaded(ctx.cwd);
      const trusted = ctx.isProjectTrusted();
      const broken = configError(trusted);
      if (broken && broken.status === "error") {
        const result = {
          ok: false as const,
          error: "invalid_permission_config" as const,
          path: broken.path,
          details: broken.error,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }
      const result = permissionProbeResult(
        params.toolName,
        params.input,
        buildLayers(trusted),
        ctx.cwd,
        home,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === PERMISSION_PROBE_NAME) return undefined;
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
    if (layers.length === 0) return undefined; // inert: no config anywhere

    const input = event.input as Record<string, unknown>;
    const decisions = evaluateToolCallDecisions({
      layers,
      toolName: event.toolName,
      input,
      cwd: ctx.cwd,
      home,
    });

    const denied = decisions.find((candidate) => candidate.action === "deny");
    if (denied) {
      const detail = denied.source ? describeSource(denied.source) : "denied";
      const message = denied.message === undefined ? "" : `\n${denied.message}`;
      return { block: true, reason: `permission: denied — ${detail}${message}` };
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
    const suggestions = sources
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
    const details = sources
      .map(
        (source) =>
          `  ${preview(source.subject)}\n\n  rule: ${source.layer} ${source.tool}[${source.pattern}]`,
      )
      .join("\n\n");
    const title = `Permission: ${toolName}\n\n${details}\n`;
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

  function layerViews(trusted: boolean, scope: PermissionLayer | "all"): LayerView[] {
    const views: LayerView[] = [];
    if (scope === "all" || scope === "global") views.push(cachedLayerView(cachedGlobal, "global"));
    if (scope === "all" || scope === "project") {
      const view = cachedLayerView(cachedProject!, "project");
      if (!trusted) view.note = `${view.note} (untrusted — ignored)`;
      views.push(view);
    }
    if (scope === "all" || scope === "session") {
      views.push({
        layer: "session",
        location: "session (in-memory)",
        note: "",
        rules: sessionConfig.entries.flatMap((entry) =>
          entry.rules.map((rule) => ({
            tool: entry.tool,
            pattern: rule.pattern,
            action: rule.action,
            ...(rule.message === undefined ? {} : { message: rule.message }),
          })),
        ),
      });
    }
    return views;
  }

  /** Toggle the session-scoped probe tool; returns whether the active set changed. */
  function setProbeTool(enabled: boolean): boolean {
    const active = pi.getActiveTools();
    const next = enabled
      ? active.includes(PERMISSION_PROBE_NAME)
        ? active
        : [...active, PERMISSION_PROBE_NAME]
      : active.filter((name) => name !== PERMISSION_PROBE_NAME);
    if (next.length === active.length) return false;
    pi.setActiveTools(next);
    return true;
  }

  function probeNotice(enabled: boolean, changed: boolean): string {
    const state = enabled ? "enabled" : "disabled";
    const scope = enabled ? " for this session" : "";
    return changed ? `permission_probe ${state}${scope}` : `permission_probe is already ${state}`;
  }

  pi.registerCommand("permission", {
    description: "Edit or inspect tool permission rules (allow / ask / deny)",
    getArgumentCompletions: permissionArgumentCompletions,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("Error: /permission requires interactive UI");
      const [rawSub = "", rawFlag = ""] = args.trim().split(/\s+/).filter(Boolean);
      const sub = rawSub.toLowerCase();
      const flag = rawFlag.toLowerCase();

      if (sub === "list") {
        const scope = (flag || "all") as PermissionLayer | "all";
        if (!LIST_SCOPES.includes(scope)) {
          ctx.ui.notify(PERMISSION_USAGE, "error");
          return;
        }
        reload(ctx.cwd);
        ctx.ui.notify(formatPermissionList(layerViews(ctx.isProjectTrusted(), scope)), "info");
        return;
      }

      if (sub === "probe") {
        if (flag !== "" && flag !== "on" && flag !== "off") {
          ctx.ui.notify(PERMISSION_USAGE, "error");
          return;
        }
        const enabled = flag !== "off";
        ctx.ui.notify(probeNotice(enabled, setProbeTool(enabled)), "info");
        return;
      }

      if (sub !== "") {
        ctx.ui.notify(PERMISSION_USAGE, "error");
        return;
      }

      reload(ctx.cwd);
      const trusted = ctx.isProjectTrusted();
      const broken = configError(trusted);
      if (broken && broken.status === "error") {
        ctx.ui.notify(
          `Error: permission config invalid (${broken.path}): ${broken.error}`,
          "error",
        );
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
