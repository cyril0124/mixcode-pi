/**
 * mpi-optimize-prompt — Rewrite the input-editor draft (or slash args) via one-shot complete.
 *
 * Usage: /opt-prompt [text]
 * Cancel: /opt-prompt-cancel
 * Config: <agentDir>/optimize-prompt.json
 *   { "model"?: "provider/id", "thinking"?: "low", "systemPrompt"?: "..." }
 * Defaults: inherit active session model + thinking; built-in system prompt.
 * Progress: aboveEditor widget (does not take over the input editor).
 */

import {
  completeSimple,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import {
  loadOptimizePromptConfig,
  optimizePromptConfigPath,
  writeOptimizePromptConfig,
} from "./config.js";
import {
  createOptimizePromptConfigOverlay,
  type ConfigOverlayResult,
} from "./config-overlay.js";
import {
  DEFAULT_OPTIMIZE_SYSTEM_PROMPT,
  extractOptimizedText,
  formatOptimizePromptHelp,
  formatOptimizeUserMessage,
  OPTIMIZE_PROMPT_INHERIT,
  parseOptimizeModelRef,
  resolveOptimizeSource,
  resolveOptimizeSystemPrompt,
  resolveOptimizeTarget,
  restorePreOptimizeDraft,
  stashPreOptimizeDraft,
  type OptimizeDraftSlot,
  type OptimizePromptConfig,
} from "./core.js";

const WIDGET_KEY = "mpi-optimize-prompt";
const PANEL_ENTRY_TYPE = "mpi-optimize-prompt-panel";

type CompleteFn = typeof completeSimple;
type PanelData = { markdown: string };

/** Per-factory cancel slot so each MixCode tab isolates in-flight optimize. */
export type OptimizeAbortSlot = {
  controller?: AbortController;
  /** Tear down progress widget immediately on cancel (provider may ignore abort). */
  stopProgress?: () => void;
};

/** Abort in-flight optimize; stops progress UI even if the HTTP stream hangs. */
export function cancelOptimize(slot: OptimizeAbortSlot): boolean {
  const controller = slot.controller;
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  try {
    slot.stopProgress?.();
  } finally {
    slot.stopProgress = undefined;
    // Drop slot so a second cancel reports idle; the run still sees its local signal.
    if (slot.controller === controller) slot.controller = undefined;
  }
  return true;
}

function notifyOptimizeCancel(
  ctx: { ui: { notify(message: string, type?: string): void } },
  slot: OptimizeAbortSlot,
): void {
  if (cancelOptimize(slot)) {
    ctx.ui.notify("Optimize cancelled", "info");
    return;
  }
  ctx.ui.notify("No optimize run in progress", "warning");
}

function compactHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function hasRequestAuth(auth: {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}): boolean {
  return Boolean(
    auth.apiKey ||
      (auth.headers && Object.keys(auth.headers).length > 0) ||
      (auth.env && Object.keys(auth.env).length > 0),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

function collapsePromptPreview(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function renderOptimizeProgressLines(
  theme: { fg(color: string, text: string): string; bold?(text: string): string },
  state: {
    frame: number;
    startedAt: number;
    modelLabel: string;
    thinkingLabel: string;
    sourceChars: number;
    sourcePreview: string;
  },
  width = 80,
): string[] {
  const spinner = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length]!;
  const elapsed = formatElapsed(Date.now() - state.startedAt);
  const bold = (text: string) => theme.bold?.(text) ?? text;
  // Bright working colors — avoid dim so the user sees the job is live.
  const title = bold(
    `${theme.fg("accent", spinner)} ${theme.fg("accent", "Optimizing prompt")}`,
  );
  const meta = [
    theme.fg("success", elapsed),
    theme.fg("warning", state.modelLabel),
    theme.fg("accent", `think:${state.thinkingLabel}`),
    theme.fg("success", `${state.sourceChars} chars`),
    theme.fg("warning", "/opt-prompt-cancel"),
  ].join(theme.fg("border", " · "));
  const statusLine = ` ${title}  ${meta}`;
  // Second line: original draft under an L-branch (└─), single-line dim preview.
  const prefix = " └─ ";
  const previewBudget = Math.max(8, width - prefix.length);
  const preview = truncateToWidth(state.sourcePreview, previewBudget, "…");
  const sourceLine = theme.fg("dim", `${prefix}${preview}`);
  return [statusLine, sourceLine];
}

/** Live aboveEditor widget: spinner + elapsed + dim original prompt preview. */
function startOptimizeProgressWidget(
  ctx: ExtensionCommandContext,
  info: { modelLabel: string; thinkingLabel: string; sourceChars: number; sourcePreview: string },
): () => void {
  const startedAt = Date.now();
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      timer = setInterval(() => {
        frame += 1;
        tui.requestRender();
      }, 120);
      return {
        render: (width: number) =>
          renderOptimizeProgressLines(
            theme,
            {
              frame,
              startedAt,
              modelLabel: info.modelLabel,
              thinkingLabel: info.thinkingLabel,
              sourceChars: info.sourceChars,
              sourcePreview: info.sourcePreview,
            },
            width,
          ),
        invalidate: () => {},
        dispose: () => {
          if (timer) {
            clearInterval(timer);
            timer = undefined;
          }
        },
      };
    },
    { placement: "aboveEditor" },
  );

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // Session may already be gone.
    }
  };
}

const SUBCOMMANDS = [
  { value: "help", label: "help", description: "Usage and config docs" },
  { value: "config", label: "config", description: "Open config overlay (model/thinking/prompt)" },
  { value: "cancel", label: "cancel", description: "Abort in-flight optimize (keeps draft)" },
  { value: "undo", label: "undo", description: "Restore pre-optimize draft" },
] as const;

const THINKING_OPTIONS = [
  OPTIMIZE_PROMPT_INHERIT,
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function listModelOptions(ctx: ExtensionCommandContext): string[] {
  const registry = ctx.modelRegistry as {
    getAvailable?: () => Array<{ provider: string; id: string }>;
    getAll?: () => Array<{ provider: string; id: string }>;
  };
  const models =
    registry.getAvailable?.() ??
    registry.getAll?.() ??
    [];
  const refs = models
    .filter((model) => model.provider && model.id && model.provider !== "faux")
    .map((model) => `${model.provider}/${model.id}`);
  // Always include the active session model even if not in available snapshot.
  if (ctx.model?.provider && ctx.model.id) {
    refs.unshift(`${ctx.model.provider}/${ctx.model.id}`);
  }
  return [...new Set(refs)].sort();
}

function findConfiguredModel(
  ctx: ExtensionCommandContext,
  modelRef: string | undefined,
): unknown {
  if (!modelRef || modelRef === OPTIMIZE_PROMPT_INHERIT) return ctx.model;
  const parsed = parseOptimizeModelRef(modelRef);
  if (!parsed) return ctx.model;
  const registry = ctx.modelRegistry as {
    find?: (provider: string, id: string) => unknown;
  };
  return registry.find?.(parsed.provider, parsed.modelId) ?? ctx.model;
}

function listThinkingOptions(model: unknown): string[] {
  const levels =
    model && typeof model === "object"
      ? getSupportedThinkingLevels(model as Model<string>)
      : THINKING_OPTIONS.filter((level) => level !== OPTIMIZE_PROMPT_INHERIT);
  return [OPTIMIZE_PROMPT_INHERIT, ...new Set(levels)];
}

export async function runOptimizePromptConfig(options: {
  ctx: ExtensionCommandContext;
  agentDir?: string;
}): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const { ctx } = options;
  const agentDir = options.agentDir ?? getAgentDir();
  const loaded = loadOptimizePromptConfig(agentDir);
  if (!loaded.ok) {
    ctx.ui.notify(`Optimize config error (${loaded.path}): ${loaded.error}`, "error");
    return { ok: false, reason: "bad_config" };
  }

  let draft: OptimizePromptConfig = { ...loaded.config };
  const modelOptions = listModelOptions(ctx);
  const configPath = optimizePromptConfigPath(agentDir);

  const persist = (config: OptimizePromptConfig): boolean => {
    draft = { ...config };
    const written = writeOptimizePromptConfig(agentDir, draft);
    if (!written.ok) {
      ctx.ui.notify(`Failed to write ${written.path}: ${written.error}`, "error");
      return false;
    }
    return true;
  };

  for (;;) {
    const result = (await ctx.ui.custom(
      (tui, theme, _kb, done) =>
        createOptimizePromptConfigOverlay({
          theme,
          requestRender: () => tui.requestRender(),
          done,
          // Model/thinking picks write immediately — no Save step.
          onChange: (config) => {
            void persist(config);
          },
          initial: draft,
          modelOptions,
          thinkingOptions: THINKING_OPTIONS,
          getThinkingOptions: (modelRef) => listThinkingOptions(findConfiguredModel(ctx, modelRef)),
          getMaxVisible: () => Math.max(3, Math.floor(tui.terminal.rows * 0.8) - 10),
        }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "72%",
          maxHeight: "80%",
          margin: 1,
        },
      },
    )) as ConfigOverlayResult | undefined;

    if (!result || result.action === "close") {
      return { ok: true, path: configPath };
    }

    if (result.action === "edit-prompt") {
      draft = { ...result.config };
      const prefill = draft.systemPrompt?.trim() || DEFAULT_OPTIMIZE_SYSTEM_PROMPT;
      const edited = await ctx.ui.editor("Optimize system prompt", prefill);
      if (edited !== undefined) {
        const trimmed = edited.trim();
        let next: OptimizePromptConfig;
        if (!trimmed || trimmed === DEFAULT_OPTIMIZE_SYSTEM_PROMPT) {
          const { systemPrompt: _drop, ...rest } = draft;
          next = rest;
        } else {
          next = { ...draft, systemPrompt: trimmed };
        }
        if (!persist(next)) return { ok: false, reason: "write_failed" };
      }
    }
  }
}

export async function runOptimizePrompt(options: {
  ctx: ExtensionCommandContext;
  args: string;
  getThinkingLevel: () => string;
  complete?: CompleteFn;
  agentDir?: string;
  /** Render help as a chat markdown panel (factory wires appendEntry). */
  showMarkdown?: (markdown: string) => void;
  /** Factory-scoped abort slot; omit only in single-shot tests. */
  abortSlot?: OptimizeAbortSlot;
  /** Factory-scoped pre-optimize draft stash for /opt-prompt undo. */
  draftSlot?: OptimizeDraftSlot;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const { ctx } = options;
  const agentDir = options.agentDir ?? getAgentDir();
  const sub = options.args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    const markdown = formatOptimizePromptHelp(optimizePromptConfigPath(agentDir));
    // Prefer session markdown panel; notify is plain text and does not render MD.
    if (options.showMarkdown) options.showMarkdown(markdown);
    else ctx.ui.notify(markdown, "info");
    return { ok: false, reason: "help" };
  }
  if (sub === "config") {
    const result = await runOptimizePromptConfig({ ctx, agentDir });
    return result.ok ? { ok: false, reason: "config_saved" } : { ok: false, reason: result.reason };
  }
  if (sub === "cancel") {
    // Prefer /opt-prompt cancel (or /opt-prompt-cancel); never treat "cancel" as draft text.
    if (!options.abortSlot) {
      ctx.ui.notify("No optimize run in progress", "warning");
      return { ok: false, reason: "no_run" };
    }
    const cancelled = cancelOptimize(options.abortSlot);
    ctx.ui.notify(
      cancelled ? "Optimize cancelled" : "No optimize run in progress",
      cancelled ? "info" : "warning",
    );
    return { ok: false, reason: cancelled ? "cancelled" : "no_run" };
  }
  if (sub === "undo") {
    // Extension-local stash: Pi has no addToHistory on ExtensionUIContext.
    if (!options.draftSlot) {
      ctx.ui.notify("No pre-optimize draft to restore", "warning");
      return { ok: false, reason: "no_draft" };
    }
    const restored = restorePreOptimizeDraft(options.draftSlot, (text) => ctx.ui.setEditorText(text));
    if (!restored.ok) {
      ctx.ui.notify("No pre-optimize draft to restore", "warning");
      return { ok: false, reason: "no_draft" };
    }
    ctx.ui.notify("Restored pre-optimize draft", "info");
    return { ok: true, text: restored.text };
  }

  const editorText = ctx.ui.getEditorText?.() ?? "";
  const source = resolveOptimizeSource(options.args, editorText);
  if (!source) {
    ctx.ui.notify(
      "Nothing to optimize. Draft first, then /opt-prompt (or /opt-prompt <text>). Cancel: /opt-prompt cancel",
      "warning",
    );
    return { ok: false, reason: "empty_source" };
  }

  // Claim the cancel slot before slow auth so /opt-prompt-cancel can land early.
  const abortSlot = options.abortSlot ?? {};
  const abort = new AbortController();
  if (abortSlot.controller && !abortSlot.controller.signal.aborted) {
    abortSlot.controller.abort();
  }
  try {
    abortSlot.stopProgress?.();
  } finally {
    abortSlot.stopProgress = undefined;
  }
  abortSlot.controller = abort;
  try {

  const loaded = loadOptimizePromptConfig(agentDir);
  if (!loaded.ok) {
    ctx.ui.notify(`Optimize config error (${loaded.path}): ${loaded.error}`, "error");
    return { ok: false, reason: "bad_config" };
  }
  const config = loaded.config;

  const activeModel = ctx.model;
  if (!activeModel && !config.model) {
    ctx.ui.notify("No model selected", "error");
    return { ok: false, reason: "no_model" };
  }

  if (abort.signal.aborted) {
    ctx.ui.notify("Optimize cancelled", "info");
    return { ok: false, reason: "cancelled" };
  }

  const target = resolveOptimizeTarget(
    {
      provider: activeModel?.provider ?? "",
      modelId: activeModel?.id ?? "",
      thinkingLevel: options.getThinkingLevel(),
    },
    config,
  );

  const model =
    config.model && config.model !== "inherit"
      ? ctx.modelRegistry.find(target.provider, target.modelId)
      : activeModel;
  if (!model) {
    ctx.ui.notify(`Unknown model: ${target.provider}/${target.modelId}`, "error");
    return { ok: false, reason: "unknown_model" };
  }

  let auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  try {
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (abort.signal.aborted) {
      ctx.ui.notify("Optimize cancelled", "info");
      return { ok: false, reason: "cancelled" };
    }
    if (
      !resolved.ok ||
      !hasRequestAuth({
        apiKey: resolved.ok ? resolved.apiKey : undefined,
        headers: resolved.ok ? compactHeaders(resolved.headers) : undefined,
        env: resolved.ok ? resolved.env : undefined,
      })
    ) {
      ctx.ui.notify(
        resolved.ok ? `No credentials for ${model.provider}` : resolved.error,
        "error",
      );
      return { ok: false, reason: "no_auth" };
    }
    auth = {
      apiKey: resolved.apiKey,
      headers: compactHeaders(resolved.headers),
      env: resolved.env,
    };
  } catch (error: unknown) {
    if (abort.signal.aborted) {
      ctx.ui.notify("Optimize cancelled", "info");
      return { ok: false, reason: "cancelled" };
    }
    ctx.ui.notify(formatError(error), "error");
    return { ok: false, reason: "no_auth" };
  }

  const systemPrompt = resolveOptimizeSystemPrompt(config);
  const runComplete = options.complete ?? completeSimple;
  const stopProgress = startOptimizeProgressWidget(ctx, {
    modelLabel: `${target.provider}/${target.modelId}`,
    thinkingLabel: target.thinkingLevel,
    sourceChars: source.length,
    sourcePreview: collapsePromptPreview(source),
  });
  abortSlot.stopProgress = stopProgress;
  try {
    const streamOptions: {
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      signal?: AbortSignal;
      reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    } = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: abort.signal,
    };
    if (target.thinkingLevel !== "off") {
      streamOptions.reasoning = target.thinkingLevel as
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max";
    }

    if (abort.signal.aborted) {
      ctx.ui.notify("Optimize cancelled", "info");
      return { ok: false, reason: "cancelled" };
    }

    const response: AssistantMessage = await runComplete(
      model as Model<string>,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: formatOptimizeUserMessage(source) }],
            timestamp: Date.now(),
          },
        ],
      },
      streamOptions,
    );
    if (abort.signal.aborted || response.stopReason === "aborted") {
      ctx.ui.notify("Optimize cancelled", "info");
      return { ok: false, reason: "cancelled" };
    }
    const optimized = extractOptimizedText(response);
    // Stash original for /opt-prompt undo (cannot push real editor Up-history from an extension).
    if (options.draftSlot) stashPreOptimizeDraft(options.draftSlot, source);
    ctx.ui.setEditorText(optimized);
    return { ok: true, text: optimized };
  } catch (error: unknown) {
    if (abort.signal.aborted) {
      ctx.ui.notify("Optimize cancelled", "info");
      return { ok: false, reason: "cancelled" };
    }
    ctx.ui.notify(`Optimize failed: ${formatError(error)}`, "error");
    return { ok: false, reason: formatError(error) };
  } finally {
    if (abortSlot.stopProgress === stopProgress) abortSlot.stopProgress = undefined;
    stopProgress();
  }
  } finally {
    if (abortSlot.controller === abort) abortSlot.controller = undefined;
  }
}

const optimizePrompt: ExtensionFactory = (pi: ExtensionAPI) => {
  // Factory-scoped so each MixCode tab (each ExtensionRunner load) isolates cancel/undo.
  const abortSlot: OptimizeAbortSlot = {};
  const draftSlot: OptimizeDraftSlot = {};

  pi.registerEntryRenderer<PanelData>(PANEL_ENTRY_TYPE, (entry, _options, theme) => {
    const markdown = entry.data?.markdown ?? "";
    return new Markdown(markdown, 1, 1, getMarkdownTheme(), {
      bgColor: (text) => theme.bg("customMessageBg", text),
    });
  });

  pi.registerCommand("opt-prompt", {
    description: "Optimize editor draft (or args); config|help|cancel|undo",
    getArgumentCompletions: (prefix: string) => {
      const filtered = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((item) => ({ ...item })) : null;
    },
    handler: async (args, ctx) => {
      const shared = {
        ctx,
        args,
        getThinkingLevel: () => pi.getThinkingLevel(),
        showMarkdown: (markdown: string) =>
          pi.appendEntry<PanelData>(PANEL_ENTRY_TYPE, { markdown }),
        abortSlot,
        draftSlot,
      };
      // Pi awaits extension command handlers serially. Sync subcommands await;
      // the rewrite path must return immediately so cancel can run.
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (
        sub === "help" ||
        sub === "--help" ||
        sub === "-h" ||
        sub === "config" ||
        sub === "cancel" ||
        sub === "undo"
      ) {
        await runOptimizePrompt(shared);
        return;
      }
      void runOptimizePrompt(shared);
    },
  });

  pi.registerCommand("opt-prompt-cancel", {
    description: "Abort in-flight /opt-prompt rewrite (keeps editor draft)",
    handler: async (_args, ctx) => {
      notifyOptimizeCancel(ctx, abortSlot);
    },
  });

  // Key path — does not go through the serial slash-command queue.
  pi.registerShortcut(Key.ctrlShift("c"), {
    description: "Cancel in-flight /opt-prompt",
    handler: (ctx) => {
      notifyOptimizeCancel(ctx, abortSlot);
    },
  });
};

export default optimizePrompt;
