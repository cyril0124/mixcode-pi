/**
 * mpi-auto-rename — Generate a short kebab-case session title from current context.
 *
 * Usage: /auto-rename
 */

import { completeSimple, type AssistantMessage, type Model } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

export const MAX_CONTEXT_CHARS = 1_000;
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

export function buildConversationContext(entries: readonly SessionEntry[]): string {
  const sections: string[] = [];
  for (const entry of entries) {
    const section = entrySection(entry);
    if (section) sections.push(section);
  }

  const recent = sections.slice(-RECENT_MESSAGE_WINDOW);
  const joined = recent.join("\n\n");
  if (joined.length <= MAX_CONTEXT_CHARS) return joined;
  return joined.slice(-MAX_CONTEXT_CHARS);
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

export async function generateValidTitle(options: {
  model: Model<string>;
  conversationContext: string;
  thinkingLevel: string;
  auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  signal?: AbortSignal;
  complete?: CompleteFn;
}): Promise<AutoRenameResult> {
  const runComplete = options.complete ?? completeSimple;
  let previous: TitleFailure | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };

    let response: AssistantMessage;
    try {
      const streamOptions: {
        apiKey?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        signal?: AbortSignal;
        maxTokens: number;
        reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
      } = {
        apiKey: options.auth.apiKey,
        headers: options.auth.headers,
        env: options.auth.env,
        signal: options.signal,
        maxTokens: 64,
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
    const candidate = parseCandidateTitle(raw);
    const error = titleValidationError(candidate);
    if (!error) return { ok: true, title: candidate };

    previous = { raw: raw || candidate || "(empty)", error };
  }

  return {
    ok: false,
    reason: `could not produce a valid title after ${MAX_ATTEMPTS} attempts`,
  };
}

export async function runAutoRename(options: {
  ctx: ExtensionCommandContext;
  setSessionName: (name: string) => void;
  getThinkingLevel: () => string;
  complete?: CompleteFn;
}): Promise<AutoRenameResult> {
  const { ctx } = options;
  const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
    ctx.ui.notify(message, level);
  };

  if (!ctx.model) {
    notify("No model selected", "error");
    return { ok: false, reason: "no_model" };
  }

  const conversationContext = buildConversationContext(ctx.sessionManager.buildContextEntries());
  if (!conversationContext.trim()) {
    notify("No conversation context available to rename", "error");
    return { ok: false, reason: "empty_context" };
  }

  let auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  try {
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!resolved.ok || !hasRequestAuth({
      apiKey: resolved.ok ? resolved.apiKey : undefined,
      headers: resolved.ok ? compactHeaders(resolved.headers) : undefined,
      env: resolved.ok ? resolved.env : undefined,
    })) {
      notify(resolved.ok ? `No credentials for ${ctx.model.provider}` : resolved.error, "error");
      return { ok: false, reason: "no_auth" };
    }
    auth = {
      apiKey: resolved.apiKey,
      headers: compactHeaders(resolved.headers),
      env: resolved.env,
    };
  } catch (error: unknown) {
    notify(formatError(error), "error");
    return { ok: false, reason: "no_auth" };
  }

  const thinkingLevel = options.getThinkingLevel();
  const generate = (signal?: AbortSignal) =>
    generateValidTitle({
      model: ctx.model as Model<string>,
      conversationContext,
      thinkingLevel,
      auth,
      signal,
      complete: options.complete,
    });

  let result: AutoRenameResult;
  if (ctx.hasUI) {
    result = await ctx.ui.custom<AutoRenameResult>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, "Generating session title...");
      loader.onAbort = () => done({ ok: false, reason: "cancelled" });
      generate(loader.signal)
        .then(done)
        .catch((error: unknown) => done({ ok: false, reason: formatError(error) }));
      return loader;
    });
  } else {
    result = await generate();
  }

  if (!result.ok) {
    if (result.reason === "cancelled") notify("Cancelled", "info");
    else notify(`Auto-rename failed: ${result.reason}`, "error");
    return result;
  }

  const currentName = ctx.sessionManager.getSessionName();
  if (currentName) {
    // MixCode's confirm dialog renders the title only; put the preview there.
    const confirmed = await ctx.ui.confirm(
      `${currentName} -> ${result.title}`,
      "Overwrite the current session title?",
    );
    if (!confirmed) {
      notify("Kept existing title", "info");
      return { ok: false, reason: "declined" };
    }
  }

  options.setSessionName(result.title);
  notify(`Session renamed: ${result.title}`, "info");
  return result;
}

const autoRename: ExtensionFactory = (pi) => {
  pi.registerCommand("auto-rename", {
    description: "Generate a short kebab-case title from current context and rename this session",
    handler: async (_args, ctx) => {
      await runAutoRename({
        ctx,
        setSessionName: (name) => pi.setSessionName(name),
        getThinkingLevel: () => pi.getThinkingLevel(),
      });
    },
  });
};

export default autoRename;
