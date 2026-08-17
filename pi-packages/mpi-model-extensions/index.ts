// +---------------------------------------------------------------------------+
// |  model-extensions extension                                               |
// |  Per-model extension load by jiti-invoking factories with host pi API.    |
// |                                                                           |
// |  Config: <agentDir>/model-extensions.json (rules array).                  |
// |  Reload: session_start (config); loads on session_start + model_select.   |
// |  UI:     /model-extensions — markdown panel (customMessageBg).            |
// +---------------------------------------------------------------------------+
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import {
  formatModelExtensionsHelp,
  isModelExtensionsEnabled,
  loadModelExtensionsConfig,
  modelExtensionsConfigPath,
  modelKey,
  planModelExtensionLoads,
  ruleMatches,
  setModelExtensionsEnabled,
  type ModelExtensionsConfig,
  type ModelExtensionsRule,
  type ModelLike,
  type PlanWarning,
} from "./model-extensions-core.js";
import { createDynamicExtensionLoader, type DynamicLoader } from "./model-extensions-loader.js";

const PANEL_ENTRY_TYPE = "mpi-model-extensions-panel";
const ARGUMENT_HINT = "[help|on|off]";
const SUBCOMMANDS = [
  { value: "help", label: "help", description: "Config schema and examples" },
  { value: "on", label: "on", description: "Enable rule application (global)" },
  { value: "off", label: "off", description: "Disable rule application (global)" },
  { value: "status", label: "status", description: "Show current status" },
] as const;

type CachedConfig =
  | { status: "missing"; path: string }
  | { status: "error"; path: string; error: string }
  | { status: "ok"; path: string; config: ModelExtensionsConfig };

type PanelData = { markdown: string };

function showPanel(pi: ExtensionAPI, markdown: string): void {
  pi.appendEntry<PanelData>(PANEL_ENTRY_TYPE, { markdown });
}

function formatStatusMarkdown(lines: {
  configPath: string;
  statusLine: string;
  enabledLine?: string;
  modelLine?: string;
  rules?: string[];
  plannedLine?: string;
  loadedLine?: string;
  warnings?: string[];
  hint?: boolean;
}): string {
  const out: string[] = [
    "# model-extensions",
    "",
    `- **config:** \`${lines.configPath}\``,
    `- **status:** ${lines.statusLine}`,
  ];
  if (lines.enabledLine) out.push(`- **enabled:** ${lines.enabledLine}`);
  if (lines.modelLine) out.push(`- **model:** ${lines.modelLine}`);
  if (lines.rules && lines.rules.length > 0) {
    out.push("", "## Rules", "");
    for (const r of lines.rules) out.push(`- ${r}`);
  }
  if (lines.plannedLine) out.push("", `**planned:** ${lines.plannedLine}`);
  if (lines.loadedLine) out.push(`**loaded (session):** ${lines.loadedLine}`);
  if (lines.warnings && lines.warnings.length > 0) {
    out.push("", "## Warnings", "");
    for (const w of lines.warnings) out.push(`- ${w}`);
  }
  if (lines.hint) {
    out.push("", "Type `/model-extensions help` for config docs.");
  }
  return out.join("\n");
}

export default function modelExtensionsExtension(pi: ExtensionAPI) {
  let cached: CachedConfig = {
    status: "missing",
    path: modelExtensionsConfigPath(getAgentDir()),
  };
  let loader: DynamicLoader = createDynamicExtensionLoader();

  pi.registerEntryRenderer<PanelData>(PANEL_ENTRY_TYPE, (entry, _options, theme) => {
    const markdown = entry.data?.markdown ?? "";
    return new Markdown(markdown, 1, 1, getMarkdownTheme(), {
      bgColor: (text) => theme.bg("customMessageBg", text),
    });
  });

  function reloadConfig(ctx?: ExtensionContext): void {
    const agentDir = getAgentDir();
    const result = loadModelExtensionsConfig(agentDir);
    if (!result.ok) {
      cached = { status: "error", path: result.path, error: result.error };
      ctx?.ui.notify(`[model-extensions] bad config ${result.path}: ${result.error}`, "error");
      return;
    }
    if ("missing" in result && result.missing) {
      cached = { status: "missing", path: result.path };
      return;
    }
    cached = { status: "ok", path: result.path, config: result.config! };
  }

  function notifyWarnings(ctx: ExtensionContext, warnings: PlanWarning[]): void {
    for (const w of warnings) {
      ctx.ui.notify(`[model-extensions] ${w.message}`, "warning");
    }
  }

  function currentModel(ctx: ExtensionContext): ModelLike | undefined {
    const m = ctx.model;
    if (!m) return undefined;
    return {
      id: m.id,
      provider: m.provider,
      input: m.input,
    };
  }

  async function applyForModel(model: ModelLike, ctx: ExtensionContext): Promise<void> {
    if (cached.status === "error" || cached.status === "missing") return;
    if (!isModelExtensionsEnabled(cached.config)) return;

    const agentDir = getAgentDir();
    const plan = planModelExtensionLoads(cached.config.rules, model, agentDir);
    notifyWarnings(ctx, plan.warnings);
    if (plan.matchedRuleIndexes.length === 0 || plan.paths.length === 0) return;

    const results = await loader.loadPaths(plan.paths, pi);
    for (const r of results) {
      if (!r.ok) {
        ctx.ui.notify(`[model-extensions] load ${r.path}: ${r.error}`, "error");
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // New session / reload: fresh loader so previously loaded factories can re-run.
    loader = createDynamicExtensionLoader();
    reloadConfig(ctx);
    const model = currentModel(ctx);
    if (model) await applyForModel(model, ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    // Add-only: cannot unload factories already invoked this session.
    if (cached.status !== "ok") return;
    if (!isModelExtensionsEnabled(cached.config)) return;
    const model: ModelLike = {
      id: event.model.id,
      provider: event.model.provider,
      input: event.model.input,
    };
    await applyForModel(model, ctx);
  });

  pi.registerCommand("model-extensions", {
    description: "[global] Show model-extensions status; on|off|help",
    getArgumentCompletions: (prefix: string) => {
      const filtered = SUBCOMMANDS.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((i) => ({ ...i })) : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "help") {
        showPanel(pi, formatModelExtensionsHelp(modelExtensionsConfigPath(getAgentDir())));
        return;
      }
      if (sub === "on" || sub === "off") {
        const enabled = sub === "on";
        const result = setModelExtensionsEnabled(getAgentDir(), enabled);
        if (!result.ok) {
          showPanel(
            pi,
            formatStatusMarkdown({
              configPath: result.path,
              statusLine: `error — ${result.error}`,
              hint: true,
            }),
          );
          return;
        }
        cached = { status: "ok", path: result.path, config: result.config };
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath: result.path,
            statusLine: `ok (${result.config.rules.length} rule(s))`,
            enabledLine: enabled ? "**on** (rules apply)" : "**off** (rules ignored)",
          }),
        );
        return;
      }
      if (sub && sub !== "status") {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath: modelExtensionsConfigPath(getAgentDir()),
            statusLine: `unknown subcommand \`${sub}\``,
            hint: true,
          }),
        );
        return;
      }

      // Refresh so the command reflects hand-edited config without full /reload.
      const snap = loadModelExtensionsConfig(getAgentDir());
      const configPath = snap.ok ? snap.path : (snap as { path: string }).path;

      if (!snap.ok) {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath,
            statusLine: `error — ${snap.error}`,
            hint: true,
          }),
        );
        return;
      }
      if ("missing" in snap && snap.missing) {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath,
            statusLine: "missing (no rules; no dynamic loads)",
            enabledLine: "on (default)",
            loadedLine:
              loader.loadedPaths.size > 0
                ? [...loader.loadedPaths].map((p) => `\`${p}\``).join(", ")
                : "(none)",
            hint: true,
          }),
        );
        return;
      }

      const config = snap.config!;
      const enabled = isModelExtensionsEnabled(config);
      const model = currentModel(ctx);
      if (!model) {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath,
            statusLine: `ok (${config.rules.length} rule(s))`,
            enabledLine: enabled ? "on" : "**off**",
            modelLine: "(none selected)",
            loadedLine:
              loader.loadedPaths.size > 0
                ? [...loader.loadedPaths].map((p) => `\`${p}\``).join(", ")
                : "(none)",
          }),
        );
        return;
      }

      const ruleLines: string[] = [];
      for (let i = 0; i < config.rules.length; i++) {
        const rule = config.rules[i]!;
        const hit = ruleMatches(rule.match, model);
        const badge = hit ? "**MATCH**" : "skip";
        ruleLines.push(
          `${badge} \`[${i}]\` match=\`${JSON.stringify(rule.match)}\` add=\`${JSON.stringify(rule.add ?? [])}\` remove=\`${JSON.stringify(rule.remove ?? [])}\``,
        );
      }

      const plan = enabled
        ? planModelExtensionLoads(config.rules, model, getAgentDir())
        : { paths: [] as string[], warnings: [] as PlanWarning[], matchedRuleIndexes: [] as number[] };

      showPanel(
        pi,
        formatStatusMarkdown({
          configPath,
          statusLine: `ok (${config.rules.length} rule(s))`,
          enabledLine: enabled ? "on" : "**off** (rules ignored)",
          modelLine: `\`${modelKey(model)}\` input=[\`${(model.input ?? []).join("`, `") || ""}\`]`,
          rules: ruleLines,
          plannedLine:
            plan.paths.length > 0 ? plan.paths.map((p) => `\`${p}\``).join(", ") : "(none)",
          loadedLine:
            loader.loadedPaths.size > 0
              ? [...loader.loadedPaths].map((p) => `\`${p}\``).join(", ")
              : "(none)",
          warnings: plan.warnings.map((w) => w.message),
        }),
      );
    },
    ...({ argumentHint: ARGUMENT_HINT } as Record<string, unknown>),
  });
}
