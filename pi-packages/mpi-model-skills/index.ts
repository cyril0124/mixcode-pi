// +---------------------------------------------------------------------------+
// |  model-skills extension                                                   |
// |  Per-model skill add/remove by rebuilding the system prompt skills block. |
// |                                                                           |
// |  Config: <agentDir>/mpi-model-skills.json (rules array).                 |
// |  Reload: session_start (startup / reload / new / resume / fork).          |
// |  Apply:  before_agent_start — match rules, rewrite <available_skills>.    |
// |  UI:     /model-skills — markdown panel (customMessageBg / light purple).  |
// +---------------------------------------------------------------------------+
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import {
  applyModelSkillRules,
  formatModelSkillsHelp,
  isModelSkillsEnabled,
  loadModelSkillsConfig,
  modelKey,
  modelSkillsConfigPath,
  ruleMatches,
  replaceSkillsInSystemPrompt,
  setModelSkillsEnabled,
  type ApplyWarning,
  type ModelLike,
  type ModelSkillsConfig,
} from "./model-skills-core.js";

const PANEL_ENTRY_TYPE = "mpi-model-skills-panel";
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
  | { status: "ok"; path: string; config: ModelSkillsConfig };

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
  effectiveLine?: string;
  warnings?: string[];
  hint?: boolean;
}): string {
  const out: string[] = ["# model-skills", "", `- **config:** \`${lines.configPath}\``, `- **status:** ${lines.statusLine}`];
  if (lines.enabledLine) out.push(`- **enabled:** ${lines.enabledLine}`);
  if (lines.modelLine) out.push(`- **model:** ${lines.modelLine}`);
  if (lines.rules && lines.rules.length > 0) {
    out.push("", "## Rules", "");
    for (const r of lines.rules) out.push(`- ${r}`);
  }
  if (lines.effectiveLine) {
    out.push("", `**effective:** ${lines.effectiveLine}`);
  }
  if (lines.warnings && lines.warnings.length > 0) {
    out.push("", "## Warnings", "");
    for (const w of lines.warnings) out.push(`- ${w}`);
  }
  if (lines.hint) {
    out.push("", "Type `/model-skills help` for config docs.");
  }
  return out.join("\n");
}

export default function modelSkillsExtension(pi: ExtensionAPI) {
  let cached: CachedConfig = {
    status: "missing",
    path: modelSkillsConfigPath(getAgentDir()),
  };

  pi.registerEntryRenderer<PanelData>(PANEL_ENTRY_TYPE, (entry, _options, theme) => {
    const markdown = entry.data?.markdown ?? "";
    // customMessageBg is theme purple/violet (#2d2838 dark / light purple label family).
    return new Markdown(markdown, 1, 1, getMarkdownTheme(), {
      bgColor: (text) => theme.bg("customMessageBg", text),
    });
  });

  function reloadConfig(ctx?: ExtensionContext): void {
    const agentDir = getAgentDir();
    const result = loadModelSkillsConfig(agentDir);
    if (!result.ok) {
      cached = { status: "error", path: result.path, error: result.error };
      ctx?.ui.notify(`[model-skills] bad config ${result.path}: ${result.error}`, "error");
      return;
    }
    if ("missing" in result && result.missing) {
      cached = { status: "missing", path: result.path };
      return;
    }
    cached = { status: "ok", path: result.path, config: result.config! };
  }

  function notifyWarnings(ctx: ExtensionContext, warnings: ApplyWarning[]): void {
    for (const w of warnings) {
      ctx.ui.notify(`[model-skills] ${w.message}`, "warning");
    }
  }

  function skillsByName(skills: readonly Skill[] | undefined): Map<string, Skill> {
    const map = new Map<string, Skill>();
    for (const s of skills ?? []) map.set(s.name, s);
    return map;
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

  pi.on("session_start", (_event, ctx) => {
    reloadConfig(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (cached.status === "error") {
      // Keep original prompt; already notified on load.
      return;
    }
    if (cached.status === "missing") return;
    if (!isModelSkillsEnabled(cached.config)) return;

    const model = currentModel(ctx);
    if (!model) return;

    const baseSkills = (event.systemPromptOptions.skills ?? []) as Skill[];
    const effective = applyModelSkillRules(
      cached.config.rules,
      model,
      baseSkills,
      skillsByName(baseSkills),
    );

    notifyWarnings(ctx, effective.warnings);

    // No matched rules and no warnings → nothing to rewrite.
    if (effective.matchedRuleIndexes.length === 0) return;

    const nextPrompt = replaceSkillsInSystemPrompt(event.systemPrompt, effective.skills);
    if (nextPrompt === event.systemPrompt) return;
    return { systemPrompt: nextPrompt };
  });

  // argumentHint is not on RegisteredCommand's published type, but registerCommand
  // spreads options and MixCode completion forwards the field for slash autocomplete.
  pi.registerCommand("model-skills", {
    description: "[global] Show model-skills status; on|off|help",
    getArgumentCompletions: (prefix: string) => {
      const filtered = SUBCOMMANDS.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((i) => ({ ...i })) : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "help") {
        showPanel(pi, formatModelSkillsHelp(modelSkillsConfigPath(getAgentDir())));
        return;
      }
      if (sub === "on" || sub === "off") {
        const enabled = sub === "on";
        const result = setModelSkillsEnabled(getAgentDir(), enabled);
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
            configPath: modelSkillsConfigPath(getAgentDir()),
            statusLine: `unknown subcommand \`${sub}\``,
            hint: true,
          }),
        );
        return;
      }

      // Refresh so the command reflects hand-edited config without full /reload.
      // Rules used by the agent still reload only on session_start (design).
      const snap = loadModelSkillsConfig(getAgentDir());
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
            statusLine: "missing (no rules; agent uses Pi skills as-is)",
            enabledLine: "on (default)",
            hint: true,
          }),
        );
        return;
      }

      const config = snap.config!;
      const enabled = isModelSkillsEnabled(config);
      const model = currentModel(ctx);
      if (!model) {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath,
            statusLine: `ok (${config.rules.length} rule(s))`,
            enabledLine: enabled ? "on" : "**off**",
            modelLine: "(none selected)",
          }),
        );
        return;
      }

      const baseSkills = (ctx.getSystemPromptOptions?.().skills ?? []) as Skill[];
      const ruleLines: string[] = [];
      for (let i = 0; i < config.rules.length; i++) {
        const rule = config.rules[i]!;
        const hit = ruleMatches(rule.match, model);
        const badge = hit ? "**MATCH**" : "skip";
        ruleLines.push(
          `${badge} \`[${i}]\` match=\`${JSON.stringify(rule.match)}\` add=\`${JSON.stringify(rule.add ?? [])}\` remove=\`${JSON.stringify(rule.remove ?? [])}\``,
        );
      }

      const applied = enabled
        ? applyModelSkillRules(config.rules, model, baseSkills, skillsByName(baseSkills))
        : { skills: [...baseSkills], warnings: [] as ApplyWarning[] };
      showPanel(
        pi,
        formatStatusMarkdown({
          configPath,
          statusLine: `ok (${config.rules.length} rule(s))`,
          enabledLine: enabled ? "on" : "**off** (rules ignored)",
          modelLine: `\`${modelKey(model)}\` input=[\`${(model.input ?? []).join("`, `") || ""}\`]`,
          rules: ruleLines,
          effectiveLine:
            applied.skills.length > 0
              ? applied.skills.map((s) => `\`${s.name}\``).join(", ")
              : "(none)",
          warnings: applied.warnings.map((w) => w.message),
        }),
      );
    },
    ...({ argumentHint: ARGUMENT_HINT } as Record<string, unknown>),
  });
}
