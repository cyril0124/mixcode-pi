/**
 * mpi-auto-rename — Generate a short kebab-case session title from current context.
 *
 * Usage: /auto-rename
 * Cancel: /auto-rename-cancel
 * Config: /auto-rename config
 *   <agentDir>/auto-rename.json  { "model"?: "provider/id", "thinking"?: "low", "onFirstMessage"?: true, "maxContextChars"?: 4000 }
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
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  AUTO_RENAME_INHERIT,
  DEFAULT_MAX_CONTEXT_CHARS,
  loadAutoRenameConfig,
  parseAutoRenameModelRef,
  resolveAutoRenameTarget,
  resolveMaxContextChars,
  writeAutoRenameConfig,
} from "./config.js";
import { createAutoRenameConfigOverlay } from "./config-overlay.js";

export const MAX_CONTEXT_CHARS = DEFAULT_MAX_CONTEXT_CHARS;
export const RECENT_MESSAGE_WINDOW = 20;
export const MAX_ATTEMPTS = 5;
export const MAX_TITLE_LENGTH = 50;

const TITLE_SEGMENT = "[a-z0-9]+";
const TITLE_PATTERN = new RegExp(`^${TITLE_SEGMENT}(?:-${TITLE_SEGMENT}){1,4}$`);

const SYSTEM_PROMPT = `You name coding-agent sessions.

Return ONLY one English kebab-case title.
Rules:
- 2 to 5 hyphen-separated segments
- lowercase ASCII letters and digits only in each segment
- at least one letter in the whole title
- max ${MAX_TITLE_LENGTH} characters
- no quotes, markdown, punctuation, or explanation
Examples: fix-login-button, implement-auto-rename, fix-gpt-5-auth`;

type CompleteFn = typeof completeSimple;

export type TitleFailure = {
  raw: string;
  error: string;
};

export type AutoRenameResult =
  | { ok: true; title: string }
  | { ok: false; reason: string };

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

type SessionMessage = {
  role?: string;
  content?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(content)) return [];

  const lines: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      const trimmed = block.text.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  return lines;
}

function entrySection(entry: SessionEntry): string | undefined {
  if (entry.type === "compaction") {
    const summary = entry.summary.trim();
    return summary ? `Compaction: ${summary}` : undefined;
  }
  if (entry.type !== "message") return undefined;

  const message = entry.message as SessionMessage;
  if (message.role !== "user" && message.role !== "assistant") return undefined;

  const lines = extractTextBlocks(message.content);
  if (lines.length === 0) return undefined;

  const label = message.role === "user" ? "User" : "Assistant";
  return `${label}: ${lines.join("\n")}`;
}

function hasPriorUserMessage(entries: readonly SessionEntry[]): boolean {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as SessionMessage;
    if (message.role === "user") return true;
  }
  return false;
}

/** True only when first-message auto-rename should start. Named sessions and later turns stay manual. */
export function shouldAutoRenameOnFirstMessage(options: {
  onFirstMessage?: boolean;
  entries: readonly SessionEntry[];
  sessionName?: string;
  prompt: string;
}): boolean {
  return (
    options.onFirstMessage === true &&
    Boolean(options.prompt.trim()) &&
    !options.sessionName &&
    !hasPriorUserMessage(options.entries)
  );
}

export function buildConversationContext(
  entries: readonly SessionEntry[],
  maxChars: number = MAX_CONTEXT_CHARS,
): string {
  const sections: string[] = [];
  for (const entry of entries) {
    const section = entrySection(entry);
    if (section) sections.push(section);
  }

  const recent = sections.slice(-RECENT_MESSAGE_WINDOW);
  const joined = recent.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(-maxChars);
}

export function parseCandidateTitle(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";
  return firstLine.replace(/^['"`]+|['"`]+$/g, "").trim();
}

export function titleValidationError(title: string): string | undefined {
  if (!title) return "title is empty";
  if (title.length > MAX_TITLE_LENGTH) return `title exceeds ${MAX_TITLE_LENGTH} characters`;
  if (!TITLE_PATTERN.test(title)) {
    return "must be kebab-case with 2-5 lowercase alphanumeric segments";
  }
  if (!/[a-z]/.test(title)) return "title must contain at least one letter";
  return undefined;
}

export function buildTitlePrompt(conversationContext: string, previous?: TitleFailure): string {
  const lines = [
    "Generate a session title for this conversation.",
    "",
    "<conversation_context>",
    conversationContext || "No conversation context was available.",
    "</conversation_context>",
  ];
  if (previous) {
    lines.push(
      "",
      `Previous invalid title: ${previous.raw}`,
      `Validation error: ${previous.error}`,
      "Return a corrected kebab-case title only.",
    );
  }
  return lines.join("\n");
}

function assistantText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
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

const WIDGET_KEY = "mpi-auto-rename";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Per-factory cancel slot so each MixCode tab isolates in-flight rename. */
export type AutoRenameAbortSlot = {
  controller?: AbortController;
  stopProgress?: () => void;
};

/** Abort in-flight rename; stops progress UI even if the HTTP stream hangs. */
export function cancelAutoRename(slot: AutoRenameAbortSlot): boolean {
  const controller = slot.controller;
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  try {
    slot.stopProgress?.();
  } finally {
    slot.stopProgress = undefined;
    if (slot.controller === controller) slot.controller = undefined;
  }
  return true;
}

function notifyAutoRenameCancel(
  ctx: { ui: { notify(message: string, type?: string): void } },
  slot: AutoRenameAbortSlot,
): void {
  if (cancelAutoRename(slot)) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }
  ctx.ui.notify("No auto-rename run in progress", "warning");
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

function renderAutoRenameProgressLines(
  theme: { fg(color: string, text: string): string; bold?(text: string): string },
  state: {
    frame: number;
    startedAt: number;
    modelLabel: string;
    thinkingLabel: string;
    sourceChars: number;
  },
): string[] {
  const spinner = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length]!;
  const elapsed = formatElapsed(Date.now() - state.startedAt);
  const bold = (text: string) => theme.bold?.(text) ?? text;
  const title = bold(
    `${theme.fg("accent", spinner)} ${theme.fg("accent", "Generating title")}`,
  );
  const meta = [
    theme.fg("success", elapsed),
    theme.fg("warning", state.modelLabel),
    theme.fg("accent", `think:${state.thinkingLabel}`),
    theme.fg("success", `${state.sourceChars} chars`),
    theme.fg("warning", "/auto-rename-cancel"),
  ].join(theme.fg("border", " · "));
  return [` ${title}  ${meta}`];
}

function startAutoRenameProgressWidget(
  ctx: ExtensionContext,
  info: { modelLabel: string; thinkingLabel: string; sourceChars: number },
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
        render: () =>
          renderAutoRenameProgressLines(theme, {
            frame,
            startedAt,
            modelLabel: info.modelLabel,
            thinkingLabel: info.thinkingLabel,
            sourceChars: info.sourceChars,
          }),
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

const FALLBACK_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function listModelOptions(ctx: ExtensionCommandContext): string[] {
  const registry = ctx.modelRegistry as {
    getAvailable?: () => Array<{ provider: string; id: string }>;
    getAll?: () => Array<{ provider: string; id: string }>;
    find?: (provider: string, id: string) => { provider: string; id: string } | undefined;
  };
  const models = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
  const refs = models
    .filter((model) => model.provider && model.id && model.provider !== "faux")
    .map((model) => `${model.provider}/${model.id}`);
  if (ctx.model?.provider && ctx.model.id) {
    refs.unshift(`${ctx.model.provider}/${ctx.model.id}`);
  }
  return [...new Set(refs)].sort();
}

function findConfiguredModel(
  ctx: ExtensionCommandContext,
  modelRef: string | undefined,
): unknown {
  if (!modelRef || modelRef === AUTO_RENAME_INHERIT) return ctx.model;
  const parsed = parseAutoRenameModelRef(modelRef);
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
      : FALLBACK_THINKING_LEVELS;
  return [AUTO_RENAME_INHERIT, ...new Set(levels)];
}

export async function generateValidTitle(options: {
  model: Model<string>;
  conversationContext: string;
  thinkingLevel: string;
  auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  signal?: AbortSignal;
  complete?: CompleteFn;
  previous?: TitleFailure;
}): Promise<AutoRenameResult> {
  const runComplete = options.complete ?? completeSimple;
  let previous: TitleFailure | undefined = options.previous;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };

    let response: AssistantMessage;
    try {
      const streamOptions: {
        apiKey?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        signal?: AbortSignal;
        reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
      } = {
        apiKey: options.auth.apiKey,
        headers: options.auth.headers,
        env: options.auth.env,
        signal: options.signal,
      };
      if (options.thinkingLevel !== "off") {
        streamOptions.reasoning = options.thinkingLevel as
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh";
      }

      response = await runComplete(
        options.model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: buildTitlePrompt(options.conversationContext, previous) }],
              timestamp: Date.now(),
            },
          ],
        },
        streamOptions,
      );
    } catch (error: unknown) {
      return { ok: false, reason: formatError(error) };
    }

    if (response.stopReason === "aborted" || options.signal?.aborted) {
      return { ok: false, reason: "cancelled" };
    }
    if (response.stopReason === "error") {
      return { ok: false, reason: response.errorMessage || "model request failed" };
    }

    const raw = assistantText(response);
    const candidate = parseCandidateTitle(raw)
      .toLowerCase()
      .replace(/[_\s]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const error = titleValidationError(candidate);
    if (!error) return { ok: true, title: candidate };

    previous = { raw: raw || candidate || "(empty)", error };
  }

  return {
    ok: false,
    reason: `could not produce a valid title after ${MAX_ATTEMPTS} attempts`,
  };
}

export async function runAutoRenameConfig(options: {
  ctx: ExtensionCommandContext;
  agentDir?: string;
}): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const { ctx } = options;
  const agentDir = options.agentDir ?? getAgentDir();
  const loaded = loadAutoRenameConfig(agentDir);
  if (!loaded.ok) {
    ctx.ui.notify(`Auto-rename config error (${loaded.path}): ${loaded.error}`, "error");
    return { ok: false, reason: "bad_config" };
  }

  let draft = { ...loaded.config };
  const persist = (config: typeof draft): void => {
    draft = { ...config };
    const written = writeAutoRenameConfig(agentDir, draft);
    if (!written.ok) {
      ctx.ui.notify(`Failed to write ${written.path}: ${written.error}`, "error");
    }
  };

  await ctx.ui.custom(
    (tui, theme, _kb, done) =>
      createAutoRenameConfigOverlay({
        theme,
        requestRender: () => tui.requestRender(),
        done: () => done(undefined),
        onChange: persist,
        initial: draft,
        modelOptions: listModelOptions(ctx),
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
  );

  return { ok: true, path: loaded.path };
}

export async function runAutoRename(options: {
  ctx: ExtensionContext;
  setSessionName: (name: string) => void;
  getThinkingLevel: () => string;
  complete?: CompleteFn;
  agentDir?: string;
  abortSlot?: AutoRenameAbortSlot;
  seedPrompt?: string;
}): Promise<AutoRenameResult> {
  const { ctx } = options;
  const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
    ctx.ui.notify(message, level);
  };

  const agentDir = options.agentDir ?? getAgentDir();
  const loaded = loadAutoRenameConfig(agentDir);
  if (!loaded.ok) {
    notify(`Auto-rename config error (${loaded.path}): ${loaded.error}`, "error");
    return { ok: false, reason: "bad_config" };
  }
  const config = loaded.config;

  const activeModel = ctx.model;
  if (!activeModel && !config.model) {
    notify("No model selected", "error");
    return { ok: false, reason: "no_model" };
  }

  const fromSession = buildConversationContext(
    ctx.sessionManager.buildContextEntries(),
    resolveMaxContextChars(config),
  );
  const seed = options.seedPrompt?.trim();
  const conversationContext = fromSession || (seed ? `User: ${seed}` : "");
  if (!conversationContext.trim()) {
    notify("No conversation context available to rename", "error");
    return { ok: false, reason: "empty_context" };
  }

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

  const target = resolveAutoRenameTarget(
    {
      provider: activeModel?.provider ?? "",
      modelId: activeModel?.id ?? "",
      thinkingLevel: options.getThinkingLevel(),
    },
    config,
  );
  const registry = ctx.modelRegistry as {
    find?: (provider: string, id: string) => unknown;
    getApiKeyAndHeaders: ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"];
  };
  const model =
    config.model && config.model !== AUTO_RENAME_INHERIT
      ? (registry.find?.(target.provider, target.modelId) as typeof activeModel)
      : activeModel;
  if (!model) {
    notify(`Unknown model: ${target.provider}/${target.modelId}`, "error");
    return { ok: false, reason: "unknown_model" };
  }

  if (abort.signal.aborted) {
    notify("Cancelled", "info");
    return { ok: false, reason: "cancelled" };
  }

  let auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  try {
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (abort.signal.aborted) {
      notify("Cancelled", "info");
      return { ok: false, reason: "cancelled" };
    }
    if (!resolved.ok || !hasRequestAuth({
      apiKey: resolved.ok ? resolved.apiKey : undefined,
      headers: resolved.ok ? compactHeaders(resolved.headers) : undefined,
      env: resolved.ok ? resolved.env : undefined,
    })) {
      notify(resolved.ok ? `No credentials for ${model.provider}` : resolved.error, "error");
      return { ok: false, reason: "no_auth" };
    }
    auth = {
      apiKey: resolved.apiKey,
      headers: compactHeaders(resolved.headers),
      env: resolved.env,
    };
  } catch (error: unknown) {
    if (abort.signal.aborted) {
      notify("Cancelled", "info");
      return { ok: false, reason: "cancelled" };
    }
    notify(formatError(error), "error");
    return { ok: false, reason: "no_auth" };
  }

  const thinkingLevel = target.thinkingLevel;
  const generateTitle = async (previous?: TitleFailure): Promise<AutoRenameResult> => {
    const stopProgress = ctx.hasUI
      ? startAutoRenameProgressWidget(ctx, {
          modelLabel: `${target.provider}/${target.modelId}`,
          thinkingLabel: thinkingLevel,
          sourceChars: conversationContext.length,
        })
      : () => {};
    abortSlot.stopProgress = stopProgress;
    try {
      return await generateValidTitle({
        model: model as Model<string>,
        conversationContext,
        thinkingLevel,
        auth,
        signal: abort.signal,
        complete: options.complete,
        previous,
      });
    } catch (error: unknown) {
      return abort.signal.aborted
        ? { ok: false, reason: "cancelled" }
        : { ok: false, reason: formatError(error) };
    } finally {
      if (abortSlot.stopProgress === stopProgress) abortSlot.stopProgress = undefined;
      stopProgress();
    }
  };

  let previous: TitleFailure | undefined;
  for (;;) {
    const result = await generateTitle(previous);
    if (!result.ok) {
      if (result.reason === "cancelled") notify("Cancelled", "info");
      else notify(`Auto-rename failed: ${result.reason}`, "error");
      return result;
    }

    const currentName = ctx.sessionManager.getSessionName();
    if (currentName) {
      // MixCode select shows title only; preview + question go in the title.
      const choice = await ctx.ui.select(
        `${currentName} -> ${result.title}\nOverwrite the current session title?`,
        ["Yes", "No", "Regenerate"],
      );
      if (choice === "Regenerate") {
        previous = {
          raw: result.title,
          error: "user rejected this title; generate a different one",
        };
        continue;
      }
      if (choice !== "Yes") {
        notify("Kept existing title", "info");
        return { ok: false, reason: "declined" };
      }
    }

    options.setSessionName(result.title);
    notify(`Session renamed: ${result.title}`, "info");
    return result;
  }
  } finally {
    if (abortSlot.controller === abort) abortSlot.controller = undefined;
  }
}

/** Start first-message auto-rename when the gate passes. Returns the in-flight run, or undefined. */
export function tryAutoRenameOnFirstMessage(options: {
  prompt: string;
  ctx: ExtensionContext;
  setSessionName: (name: string) => void;
  getThinkingLevel: () => string;
  abortSlot?: AutoRenameAbortSlot;
  agentDir?: string;
  complete?: CompleteFn;
}): Promise<AutoRenameResult> | undefined {
  const agentDir = options.agentDir ?? getAgentDir();
  const loaded = loadAutoRenameConfig(agentDir);
  if (!loaded.ok) return undefined;
  if (
    !shouldAutoRenameOnFirstMessage({
      onFirstMessage: loaded.config.onFirstMessage,
      entries: options.ctx.sessionManager.buildContextEntries(),
      sessionName: options.ctx.sessionManager.getSessionName(),
      prompt: options.prompt,
    })
  ) {
    return undefined;
  }
  return runAutoRename({
    ctx: options.ctx,
    setSessionName: options.setSessionName,
    getThinkingLevel: options.getThinkingLevel,
    abortSlot: options.abortSlot,
    agentDir,
    complete: options.complete,
    seedPrompt: options.prompt,
  });
}

const autoRename: ExtensionFactory = (pi) => {
  const abortSlot: AutoRenameAbortSlot = {};

  pi.on("before_agent_start", (event, ctx) => {
    void tryAutoRenameOnFirstMessage({
      prompt: event.prompt,
      ctx,
      setSessionName: (name) => pi.setSessionName(name),
      getThinkingLevel: () => pi.getThinkingLevel(),
      abortSlot,
    });
  });

  pi.registerCommand("auto-rename", {
    description: "Generate a kebab-case session title; config opens the settings list",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "config", label: "config", description: "Open settings list (model / thinking / first message / max context chars)" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "config") {
        await runAutoRenameConfig({ ctx });
        return;
      }
      void runAutoRename({
        ctx,
        setSessionName: (name) => pi.setSessionName(name),
        getThinkingLevel: () => pi.getThinkingLevel(),
        abortSlot,
      });
    },
  });

  pi.registerCommand("auto-rename-cancel", {
    description: "Abort in-flight /auto-rename title generation",
    handler: async (_args, ctx) => {
      notifyAutoRenameCancel(ctx, abortSlot);
    },
  });
};

export default autoRename;
