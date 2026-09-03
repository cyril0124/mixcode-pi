// +---------------------------------------------------------------------------+
// |  model-attach extension                                                   |
// |  Per-model skill add/remove (system prompt) and extension factory load.   |
// |                                                                           |
// |  Config: <agentDir>/mpi-model-attach.json (skills + extensions sections). |
// |  Reload: session_start (startup / reload / new / resume / fork).          |
// |  Skills: before_agent_start — match rules, rewrite <available_skills>.    |
// |  Exts:   session_start + model_select (add-only).                         |
// |  UI:     /model-attach — markdown panel (customMessageBg / light purple). |
// +---------------------------------------------------------------------------+
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import {
  applyModelSkillRules,
  formatModelAttachHelp,
  isSectionEnabled,
  loadModelAttachConfig,
  modelAttachConfigPath,
  modelKey,
  planModelExtensionLoads,
  replaceSkillsInSystemPrompt,
  ruleMatches,
  setSectionEnabled,
  type ApplyWarning,
  type ConfigSectionName,
  type ModelAttachConfig,
  type ModelLike,
  type PlanWarning,
} from "./model-attach-core.js";
import { createDynamicExtensionLoader, type DynamicLoader } from "./model-attach-loader.js";

const PANEL_ENTRY_TYPE = "mpi-model-attach-panel";
const ARGUMENT_HINT = "[help|skills on|off|extensions on|off]";
const ROOT_SUBCOMMANDS = [
  { value: "help", label: "help", description: "Config schema and examples" },
  { value: "skills", label: "skills", description: "Enable or disable skill rules (on|off)" },
  {
    value: "extensions",
    label: "extensions",
    description: "Enable or disable extension rules (on|off)",
  },
] as const;
const ON_OFF = [
  { value: "on", label: "on", description: "Enable this section (global)" },
  { value: "off", label: "off", description: "Disable this section (global)" },
] as const;

type CachedConfig =
  | { status: "missing"; path: string }
  | { status: "error"; path: string; error: string }
  | { status: "ok"; path: string; config: ModelAttachConfig };

type PanelData = { markdown: string };

function showPanel(pi: ExtensionAPI, markdown: string): void {
  pi.appendEntry<PanelData>(PANEL_ENTRY_TYPE, { markdown });
}

function formatStatusMarkdown(lines: {
  configPath: string;
  statusLine: string;
  modelLine?: string;
  skillsEnabled?: string;
  skillsRules?: string[];
  skillsEffective?: string;
  extensionsEnabled?: string;
  extensionsRules?: string[];
  plannedLine?: string;
  loadedLine?: string;
  warnings?: string[];
  hint?: boolean;
}): string {
  const out: string[] = [
    "# model-attach",
    "",
    `- **config:** \`${lines.configPath}\``,
    `- **status:** ${lines.statusLine}`,
  ];
  if (lines.modelLine) out.push(`- **model:** ${lines.modelLine}`);

  if (
    lines.skillsEnabled ||
    (lines.skillsRules && lines.skillsRules.length > 0) ||
    lines.skillsEffective
  ) {
    out.push("", "## Skills");
    if (lines.skillsEnabled) out.push("", `- **enabled:** ${lines.skillsEnabled}`);
    if (lines.skillsRules && lines.skillsRules.length > 0) {
      out.push("", "### Rules", "");
      for (const r of lines.skillsRules) out.push(`- ${r}`);
    }
    if (lines.skillsEffective) out.push("", `**effective:** ${lines.skillsEffective}`);
  }

  if (
    lines.extensionsEnabled ||
    (lines.extensionsRules && lines.extensionsRules.length > 0) ||
    lines.plannedLine ||
    lines.loadedLine
  ) {
    out.push("", "## Extensions");
    if (lines.extensionsEnabled) out.push("", `- **enabled:** ${lines.extensionsEnabled}`);
    if (lines.extensionsRules && lines.extensionsRules.length > 0) {
      out.push("", "### Rules", "");
      for (const r of lines.extensionsRules) out.push(`- ${r}`);
    }
    if (lines.plannedLine) out.push("", `**planned:** ${lines.plannedLine}`);
    if (lines.loadedLine) out.push(`**loaded (session):** ${lines.loadedLine}`);
  }

  if (lines.warnings && lines.warnings.length > 0) {
    out.push("", "## Warnings", "");
    for (const w of lines.warnings) out.push(`- ${w}`);
  }
  if (lines.hint) {
    out.push("", "Type `/model-attach help` for config docs.");
  }
  return out.join("\n");
}

function ruleLines(
  rules: { match: unknown; add?: string[]; remove?: string[] }[],
  model: ModelLike,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const hit = ruleMatches(rule.match as Parameters<typeof ruleMatches>[0], model);
    const badge = hit ? "**MATCH**" : "skip";
    out.push(
      `${badge} \`[${i}]\` match=\`${JSON.stringify(rule.match)}\` add=\`${JSON.stringify(rule.add ?? [])}\` remove=\`${JSON.stringify(rule.remove ?? [])}\``,
    );
  }
  return out;
}

export default function modelAttachExtension(pi: ExtensionAPI) {
  let cached: CachedConfig = {
    status: "missing",
    path: modelAttachConfigPath(getAgentDir()),
  };
  let loader: DynamicLoader = createDynamicExtensionLoader();

  pi.registerEntryRenderer<PanelData>(PANEL_ENTRY_TYPE, (entry, _options, theme) => {
    const markdown = entry.data?.markdown ?? "";
    return new Markdown(markdown, 1, 1, getMarkdownTheme(), {
      bgColor: (text) => theme.bg("customMessageBg", text),
    });
  });

  function reloadConfig(ctx?: ExtensionContext): void {
    const result = loadModelAttachConfig(getAgentDir());
    if (!result.ok) {
      cached = { status: "error", path: result.path, error: result.error };
      ctx?.ui.notify(`[model-attach] bad config ${result.path}: ${result.error}`, "error");
      return;
    }
    if ("missing" in result && result.missing) {
      cached = { status: "missing", path: result.path };
      return;
    }
    cached = { status: "ok", path: result.path, config: result.config! };
  }

  function notifyWarnings(ctx: ExtensionContext, warnings: Array<{ message: string }>): void {
    for (const w of warnings) {
      ctx.ui.notify(`[model-attach] ${w.message}`, "warning");
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

  async function applyExtensionsForModel(model: ModelLike, ctx: ExtensionContext): Promise<void> {
    if (cached.status !== "ok") return;
    const section = cached.config.extensions;
    if (!section || !isSectionEnabled(section)) return;

    const plan = planModelExtensionLoads(section.rules, model, getAgentDir());
    notifyWarnings(ctx, plan.warnings);
    if (plan.matchedRuleIndexes.length === 0 || plan.paths.length === 0) return;

    const results = await loader.loadPaths(plan.paths, pi);
    for (const r of results) {
      if (!r.ok) {
        ctx.ui.notify(`[model-attach] load ${r.path}: ${r.error}`, "error");
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    loader = createDynamicExtensionLoader();
    reloadConfig(ctx);
    const model = currentModel(ctx);
    if (model) await applyExtensionsForModel(model, ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (cached.status !== "ok") return;
    const section = cached.config.skills;
    if (!section || !isSectionEnabled(section)) return;

    const model = currentModel(ctx);
    if (!model) return;

    const baseSkills = (event.systemPromptOptions.skills ?? []) as Skill[];
    const effective = applyModelSkillRules(
      section.rules,
      model,
      baseSkills,
      skillsByName(baseSkills),
    );

    notifyWarnings(ctx, effective.warnings);
    if (effective.matchedRuleIndexes.length === 0) return;

    const nextPrompt = replaceSkillsInSystemPrompt(event.systemPrompt, effective.skills);
    if (nextPrompt === event.systemPrompt) return;
    return { systemPrompt: nextPrompt };
  });

  pi.on("model_select", async (event, ctx) => {
    if (cached.status !== "ok") return;
    const section = cached.config.extensions;
    if (!section || !isSectionEnabled(section)) return;
    const model: ModelLike = {
      id: event.model.id,
      provider: event.model.provider,
      input: event.model.input,
    };
    await applyExtensionsForModel(model, ctx);
  });

  pi.registerCommand("model-attach", {
    description: "[global] Show model-attach status; skills|extensions on|off|help",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const space = trimmed.search(/\s/);
      if (space >= 0) {
        const first = trimmed.slice(0, space).toLowerCase();
        const rest = trimmed.slice(space).trimStart();
        if (first === "skills" || first === "extensions") {
          const filtered = ON_OFF.filter((i) => i.value.startsWith(rest));
          return filtered.length > 0 ? filtered.map((i) => ({ ...i })) : null;
        }
        return null;
      }
      const filtered = ROOT_SUBCOMMANDS.filter((i) => i.value.startsWith(trimmed));
      return filtered.length > 0 ? filtered.map((i) => ({ ...i })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase() ?? "";
      const flag = tokens[1]?.toLowerCase() ?? "";

      if (sub === "help") {
        showPanel(pi, formatModelAttachHelp(modelAttachConfigPath(getAgentDir())));
        return;
      }

      if (sub === "skills" || sub === "extensions") {
        if (flag !== "on" && flag !== "off") {
          showPanel(
            pi,
            formatStatusMarkdown({
              configPath: modelAttachConfigPath(getAgentDir()),
              statusLine: `Error: Usage: /model-attach ${sub} on|off`,
              hint: true,
            }),
          );
          return;
        }
        const enabled = flag === "on";
        const result = setSectionEnabled(getAgentDir(), sub as ConfigSectionName, enabled);
        if (!result.ok) {
          showPanel(
            pi,
            formatStatusMarkdown({
              configPath: result.path,
              statusLine: `Error: ${result.error}`,
              hint: true,
            }),
          );
          return;
        }
        cached = { status: "ok", path: result.path, config: result.config };
        const section = result.config[sub as ConfigSectionName];
        const ruleCount = section?.rules.length ?? 0;
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath: result.path,
            statusLine: `ok (${ruleCount} ${sub} rule(s))`,
            skillsEnabled:
              sub === "skills"
                ? enabled
                  ? "**on** (rules apply)"
                  : "**off** (rules ignored)"
                : undefined,
            extensionsEnabled:
              sub === "extensions"
                ? enabled
                  ? "**on** (rules apply)"
                  : "**off** (rules ignored)"
                : undefined,
          }),
        );
        return;
      }

      if (sub) {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath: modelAttachConfigPath(getAgentDir()),
            statusLine: `Error: Unknown subcommand: ${sub}`,
            hint: true,
          }),
        );
        return;
      }

      const snap = loadModelAttachConfig(getAgentDir());
      const configPath = snap.ok ? snap.path : (snap as { path: string }).path;

      if (!snap.ok) {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath,
            statusLine: `Error: ${snap.error}`,
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
            statusLine: "missing (no rules; Pi skills and extensions as-is)",
            skillsEnabled: "on (default)",
            extensionsEnabled: "on (default)",
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
      const model = currentModel(ctx);
      const skillsSection = config.skills;
      const extensionsSection = config.extensions;
      const skillsOn = isSectionEnabled(skillsSection);
      const extensionsOn = isSectionEnabled(extensionsSection);

      const loadedLine =
        loader.loadedPaths.size > 0
          ? [...loader.loadedPaths].map((p) => `\`${p}\``).join(", ")
          : "(none)";

      if (!model) {
        showPanel(
          pi,
          formatStatusMarkdown({
            configPath,
            statusLine: `ok (skills ${skillsSection?.rules.length ?? 0}, extensions ${extensionsSection?.rules.length ?? 0} rule(s))`,
            skillsEnabled: skillsSection
              ? skillsOn
                ? "on"
                : "**off**"
              : "on (default, no section)",
            extensionsEnabled: extensionsSection
              ? extensionsOn
                ? "on"
                : "**off**"
              : "on (default, no section)",
            modelLine: "(none selected)",
            loadedLine,
          }),
        );
        return;
      }

      const baseSkills = (ctx.getSystemPromptOptions?.().skills ?? []) as Skill[];
      const applied =
        skillsSection && skillsOn
          ? applyModelSkillRules(skillsSection.rules, model, baseSkills, skillsByName(baseSkills))
          : { skills: [...baseSkills], warnings: [] as ApplyWarning[] };
      const plan =
        extensionsSection && extensionsOn
          ? planModelExtensionLoads(extensionsSection.rules, model, getAgentDir())
          : { paths: [] as string[], warnings: [] as PlanWarning[] };

      const warnings = [
        ...applied.warnings.map((w) => w.message),
        ...plan.warnings.map((w) => w.message),
      ];

      showPanel(
        pi,
        formatStatusMarkdown({
          configPath,
          statusLine: `ok (skills ${skillsSection?.rules.length ?? 0}, extensions ${extensionsSection?.rules.length ?? 0} rule(s))`,
          skillsEnabled: skillsSection
            ? skillsOn
              ? "on"
              : "**off** (rules ignored)"
            : "on (default, no section)",
          extensionsEnabled: extensionsSection
            ? extensionsOn
              ? "on"
              : "**off** (rules ignored)"
            : "on (default, no section)",
          modelLine: `\`${modelKey(model)}\` input=[\`${(model.input ?? []).join("`, `") || ""}\`]`,
          skillsRules: skillsSection ? ruleLines(skillsSection.rules, model) : undefined,
          skillsEffective:
            applied.skills.length > 0
              ? applied.skills.map((s) => `\`${s.name}\``).join(", ")
              : "(none)",
          extensionsRules: extensionsSection
            ? ruleLines(extensionsSection.rules, model)
            : undefined,
          plannedLine:
            plan.paths.length > 0 ? plan.paths.map((p) => `\`${p}\``).join(", ") : "(none)",
          loadedLine,
          warnings,
        }),
      );
    },
    ...({ argumentHint: ARGUMENT_HINT } as Record<string, unknown>),
  });
}
