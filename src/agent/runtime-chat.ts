import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
  CustomEntry,
  EntryRenderer,
  MessageRenderer,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Component, TuiMainScreen as PiTui } from "@earendil-works/pi-tui";
import { modelToRef } from "../core/models.js";
import type { MixCodeModel, MixCodeTabInfo, PreviewMessageRole } from "../core/types.js";
import { clearPendingEscape } from "../core/tab-state.js";
import { discardVimTranscriptSearch } from "../core/tabs.js";
import {
  currentExtensionTheme,
  getActiveExtensionThemeId,
} from "./runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "./runtime-pi-tui-bridge.js";
import { NullTerminal } from "./runtime-null-terminal.js";
import {
  contentImages,
  contentText,
  userMessageText,
  normalizeToolResult,
  summarizeToolContent,
  toolExecutionToChatLine,
} from "./runtime-tool-chat.js";
import type { ChatLine, CustomMessageLike, RuntimeTab } from "./runtime-types.js";

export function assistantDisplayText(_tab: MixCodeTabInfo, message: AssistantMessage): string {
  return assistantText(message.content);
}

/**
 * Pi interactive-mode display kinds:
 * - status: showStatus (consecutive lines coalesce / replace)
 * - error / warning: always append, break status chain
 * - block: permanent multi-line Markdown dump (e.g. /help), never coalesced
 * - plain: permanent multi-line plain dump (e.g. /session), never coalesced
 */
export type SystemMessageKind = "status" | "error" | "warning" | "block" | "plain";

export function appendSystemMessage(
  runtimeTab: RuntimeTab,
  text: string,
  kind: SystemMessageKind = text.startsWith("Error:") ? "error" : "status",
): void {
  if (!text.trim()) return;

  // Match Pi interactive-mode showStatus: consecutive status lines replace the last
  // one instead of spamming the chat. Errors/warnings/blocks always append and break the chain.
  if (kind === "status") {
    const last = runtimeTab.chat.at(-1);
    if (last?.role === "system" && last.systemStatus) {
      last.text = text;
      last.variant = undefined;
      const preview = runtimeTab.tab.previewMessages;
      const lastPreview = preview.at(-1);
      if (lastPreview?.role === "system") {
        lastPreview.text = text;
        runtimeTab.tab.previewIndex = preview.length - 1;
      } else {
        appendPreviewMessage(runtimeTab.tab, "system", text);
      }
      return;
    }
  }

  const variant =
    kind === "error"
      ? ("system-error" as const)
      : kind === "warning"
        ? ("system-warning" as const)
        : kind === "plain"
          ? ("system-plain" as const)
          : undefined;
  runtimeTab.chat.push({
    role: "system",
    text,
    variant,
    systemStatus: kind === "status" ? true : undefined,
  });
  appendPreviewMessage(runtimeTab.tab, "system", text);
}

/**
 * True when the Pi SDK refused compaction because the session has nothing to
 * summarize (everything still fits the keep-recent window). SDK 0.80+ throws
 * instead of producing an empty summary; callers treat this as a benign no-op
 * rather than an error. Matches both the manual guard wording and the SDK's.
 */
export function isNothingToCompactError(message: string): boolean {
  return /nothing to compact|session too small/i.test(message);
}

export function appendEmptyRunNotice(runtimeTab: RuntimeTab): void {
  const start = runtimeTab.currentRunChatStartIndex;
  if (start === undefined) return;
  const visibleOutput = runtimeTab.chat
    .slice(start)
    .some((line) => line.role !== "user" && line.text.trim());
  if (!visibleOutput) appendSystemMessage(runtimeTab, "Agent finished without a response.");
}

/**
 * True when the in-flight run has produced no visible assistant output yet:
 * no assistant text and no tool lines with content since the run started.
 * Mirrors the zero-output check used by appendEmptyRunNotice so a double-Esc
 * retract and the "finished without a response" notice agree on what counts.
 */
export function hasNoVisibleRunOutput(runtimeTab: RuntimeTab): boolean {
  const start = runtimeTab.currentRunChatStartIndex;
  if (start === undefined) return false;
  return !runtimeTab.chat.slice(start).some((line) => line.role !== "user" && line.text.trim());
}

export function surfaceAssistantStopReason(
  runtimeTab: RuntimeTab,
  message: AssistantMessage,
): void {
  const text = assistantStopReasonText(message);
  const isLengthStop = message.stopReason === "length";
  const pendingToolIndices = runtimeTab.chat
    .map((line, index) => ({ line, index }))
    .filter(
      (item) =>
        item.line.role === "tool" &&
        (item.line.status === "pending" || item.line.status === "running"),
    )
    .map((item) => item.index);
  if (pendingToolIndices.length && !isLengthStop) {
    // Tools still in flight need a terminal status; generic aborts use a calm label.
    // length is not a tool failure (Pi setArgsComplete path) — leave tools alone.
    const toolText = text || "Cancelled";
    for (const index of pendingToolIndices) {
      const line = runtimeTab.chat[index];
      if (line?.role !== "tool") continue;
      runtimeTab.chat[index] = { ...line, status: "error", text: toolText };
    }
    return;
  }
  // Empty aborted assistant with generic provider wording: stay silent.
  // Intentional aborts (compact, extension stop, etc.) surface their own status.
  if (!text) return;
  // length always surfaces (Pi shows it after partial content); aborted/error only when empty.
  if (isLengthStop || !assistantText(message.content).trim()) {
    appendSystemMessage(runtimeTab, text, isLengthStop ? "error" : undefined);
  }
}

/** Provider boilerplate for intentional aborts (Esc, extension stop, compact, etc.). */
export function isGenericAbortMessage(errorMessage: string | undefined): boolean {
  if (!errorMessage?.trim()) return true;
  return /^(request was aborted|request aborted|operation aborted|aborted)\.?$/i.test(
    errorMessage.trim(),
  );
}

function assistantStopReasonText(message: AssistantMessage): string {
  // Match Pi AssistantMessageComponent: always surface length truncation.
  if (message.stopReason === "length") {
    return "Response was truncated before completion.";
  }
  if (message.stopReason === "aborted") {
    // Generic abort wording is not a user-facing failure by itself; callers that
    // own the abort should surface a specific status. Non-generic messages still show.
    if (isGenericAbortMessage(message.errorMessage)) return "";
    return message.errorMessage ?? "";
  }
  if (message.stopReason === "error") {
    return `Error: ${message.errorMessage || "Unknown error"}`;
  }
  return "";
}

/**
 * Session CustomEntry (appendEntry) — not in LLM context.
 * Pi only shows these when an EntryRenderer exists and returns a component;
 * no renderer / undefined component → hidden (not a text fallback).
 * Renderer throw → visible error line (Pi CustomEntryComponent error box).
 */
export function customEntryToChatLine(
  entry: CustomEntry,
  runtimeTab: RuntimeTab,
): ChatLine | undefined {
  const renderer = runtimeTab.agentSession.extensionRunner.getEntryRenderer(entry.customType);
  // Match Pi interactive-mode addCustomEntryToChat: skip when no renderer.
  if (!renderer) return undefined;

  const title = entry.customType ? `extension ${entry.customType}` : "extension";
  const text =
    entry.data === undefined
      ? ""
      : typeof entry.data === "string"
        ? entry.data
        : JSON.stringify(entry.data);
  const line: ChatLine = {
    role: "extension",
    title,
    customType: entry.customType,
    text,
  };
  line.renderExtension = (width) =>
    renderPersistentExtensionEntry(line, entry, renderer, width, runtimeTab);

  // Probe once: hide when renderer returns undefined (Pi hasContent() === false).
  // Keep the line when the probe is an error string (renderer threw).
  const probe = line.renderExtension(80);
  if (!line.extensionRendererLastComponent) {
    const isError = probe.some((row) => row.includes("renderer error"));
    if (!isError) return undefined;
  }
  return line;
}

export function customMessageToChatLine(
  message: AgentMessage,
  runtimeTab: RuntimeTab,
): ChatLine | undefined {
  if (!isCustomMessage(message)) return undefined;
  // Hidden (display:false) messages only render when the per-tab debug toggle
  // is on; they get a [hidden] marker so they are distinguishable from
  // messages that are visible by design.
  if (!message.display && !runtimeTab.showHiddenMessages) return undefined;
  const text = contentText(message.content);
  const baseTitle = message.customType ? `extension ${message.customType}` : "extension";
  const title = message.display ? baseTitle : `${baseTitle} [hidden]`;
  const renderer = runtimeTab.agentSession.extensionRunner.getMessageRenderer(message.customType);
  const line: ChatLine = {
    role: "extension",
    title,
    customType: message.customType,
    text,
  };
  if (renderer) {
    line.renderExtension = (width) =>
      renderPersistentExtensionMessage(line, message, renderer, width, runtimeTab);
  }
  return line;
}

function isCustomMessage(message: AgentMessage): message is CustomMessageLike {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: unknown }).role === "custom"
  );
}

function renderPersistentExtensionMessage(
  line: ChatLine,
  message: CustomMessageLike,
  renderer: MessageRenderer,
  width: number,
  runtimeTab: RuntimeTab,
): string[] {
  const terminal = new NullTerminal(Math.max(1, Math.floor(width)));
  const tui = new PiTui(terminal);
  // Mirror mixcode keybindings to every pi-tui module instance so upstream
  // extension renderers see the same manager we do.
  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    // Match Pi: options.expanded tracks tools-expanded; outputPad comes from settings.
    const expanded = runtimeTab.tab.extensionUi.toolsExpanded ?? false;
    const outputPad = runtimeTab.agentSession.settingsManager.getOutputPad();
    const themeId = getActiveExtensionThemeId();
    if (
      line.extensionRendererLastComponent &&
      line.extensionRendererExpanded === expanded &&
      line.extensionRendererThemeId === themeId &&
      line.extensionRendererOutputPad === outputPad
    ) {
      return line.extensionRendererLastComponent.render(terminal.columns);
    }
    const component = renderer(message, { expanded, outputPad }, currentExtensionTheme()) as
      | (Component & { dispose?(): void })
      | undefined;
    if (line.extensionRendererLastComponent && line.extensionRendererLastComponent !== component) {
      line.extensionRendererLastComponent.dispose?.();
    }
    line.extensionRendererLastComponent = component;
    line.extensionRendererExpanded = expanded;
    line.extensionRendererThemeId = themeId;
    line.extensionRendererOutputPad = outputPad;
    if (!component) return defaultExtensionMessageLines(message);
    return component.render(terminal.columns);
  } catch (error) {
    line.extensionRendererLastComponent?.dispose?.();
    line.extensionRendererLastComponent = undefined;
    const detail = error instanceof Error ? error.message : String(error);
    return [`extension renderer error (${message.customType}): ${detail}`];
  } finally {
    restoreKeybindings();
    tui.stop();
  }
}

function defaultExtensionMessageLines(message: CustomMessageLike): string[] {
  const title = message.customType ? `[${message.customType}]` : "[extension]";
  const text = contentText(message.content).trim();
  return text ? [title, ...text.split(/\r?\n/)] : [title || "extension message"];
}

function renderPersistentExtensionEntry(
  line: ChatLine,
  entry: CustomEntry,
  renderer: EntryRenderer,
  width: number,
  runtimeTab: RuntimeTab,
): string[] {
  const terminal = new NullTerminal(Math.max(1, Math.floor(width)));
  const tui = new PiTui(terminal);
  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    // Match Pi CustomEntryComponent.setExpanded(toolOutputExpanded).
    const expanded = runtimeTab.tab.extensionUi.toolsExpanded ?? false;
    const themeId = getActiveExtensionThemeId();
    if (
      line.extensionRendererLastComponent &&
      line.extensionRendererExpanded === expanded &&
      line.extensionRendererThemeId === themeId
    ) {
      return line.extensionRendererLastComponent.render(terminal.columns);
    }
    const component = renderer(entry, { expanded }, currentExtensionTheme()) as
      | (Component & { dispose?(): void })
      | undefined;
    if (line.extensionRendererLastComponent && line.extensionRendererLastComponent !== component) {
      line.extensionRendererLastComponent.dispose?.();
    }
    line.extensionRendererLastComponent = component;
    line.extensionRendererExpanded = expanded;
    line.extensionRendererThemeId = themeId;
    // Pi: undefined component → no content, entry not shown.
    if (!component) return [];
    return component.render(terminal.columns);
  } catch (error) {
    line.extensionRendererLastComponent?.dispose?.();
    line.extensionRendererLastComponent = undefined;
    const detail = error instanceof Error ? error.message : String(error);
    return [`extension entry renderer error (${entry.customType}): ${detail}`];
  } finally {
    restoreKeybindings();
    tui.stop();
  }
}

export function disposeChatRenderers(chat: ChatLine[]): void {
  for (const line of chat) {
    line.extensionRendererLastComponent?.dispose?.();
    line.extensionRendererLastComponent = undefined;
    line.toolCallRendererLastComponent?.dispose?.();
    line.toolCallRendererLastComponent = undefined;
    line.toolResultRendererLastComponent?.dispose?.();
    line.toolResultRendererLastComponent = undefined;
  }
}

export function assistantText(
  content: Array<{ type: string; text?: string; thinking?: string; name?: string }>,
): string {
  return content
    .map((block) => {
      if (block.text !== undefined) return block.text;
      return "";
    })
    .filter((text) => text.trim())
    .join("\n");
}

function userMessageTimestamp(messageTimestamp: unknown, entryTimestamp: string): number | undefined {
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
    return messageTimestamp;
  }
  const parsed = Date.parse(entryTimestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function entryToChatLines(entry: SessionEntry, runtimeTab: RuntimeTab): ChatLine[] {
  if (entry.type === "compaction") {
    return [
      {
        role: "system",
        text: entry.summary,
        compactionSummary: true,
        compactionTokensBefore: entry.tokensBefore,
      },
    ];
  }
  if (entry.type === "branch_summary") {
    return [
      { role: "system", text: entry.summary, branchSummary: true },
    ];
  }
  if (entry.type === "custom_message") {
    const line = customMessageToChatLine(
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: Date.parse(entry.timestamp),
      },
      runtimeTab,
    );
    return line ? [line] : [];
  }
  if (entry.type === "custom") {
    const line = customEntryToChatLine(entry, runtimeTab);
    return line ? [line] : [];
  }
  if (entry.type !== "message") return [];
  const message = entry.message;
  if (message.role === "user") {
    // Pi getUserMessageText: body is text-only; images ride on ChatLine.images.
    const text = userMessageText(message.content);
    const images = contentImages(message.content);
    if (!text.trim() && images.length === 0) return [];
    const timestamp = userMessageTimestamp(message.timestamp, entry.timestamp);
    return [
      {
        role: "user",
        text,
        entryId: entry.id,
        ...(images.length > 0 ? { images } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
      },
    ];
  }
  if (message.role === "assistant") return assistantMessageToChatLines(message, runtimeTab);
  if (message.role === "bashExecution") {
    return [bashExecutionToChatLine(message)];
  }
  if (message.role === "custom") {
    const line = customMessageToChatLine(message, runtimeTab);
    return line ? [line] : [];
  }
  return [];
}

function bashExecutionToChatLine(
  message: Extract<AgentMessage, { role: "bashExecution" }>,
): ChatLine {
  const status =
    message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0)
      ? "error"
      : "success";
  return {
    role: "tool",
    title: "bash",
    variant: "user-bash",
    status,
    text: message.output,
    args: { command: message.command },
    excludeFromContext: message.excludeFromContext,
    bashExitCode: message.exitCode,
    bashCancelled: message.cancelled,
    bashTruncated: message.truncated,
    bashFullOutputPath: message.fullOutputPath,
  };
}

export function entriesToChatLines(entries: SessionEntry[], runtimeTab: RuntimeTab): ChatLine[] {
  const chat: ChatLine[] = [];
  const toolCallIndices = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const message = entry.message;
      const existing = toolCallIndices.get(message.toolCallId);
      if (existing !== undefined && chat[existing]?.role === "tool") {
        const previous = chat[existing]!;
        chat[existing] = toolExecutionToChatLine(runtimeTab, {
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          status: message.isError ? "error" : "success",
          text: summarizeToolContent(message.content, message.isError),
          args: previous.args,
          result: normalizeToolResult(message, message.isError),
          isPartial: false,
          previous,
        });
      }
      continue;
    }
    for (const line of entryToChatLines(entry, runtimeTab)) {
      if (line.role === "tool" && line.toolCallId) {
        const existing = toolCallIndices.get(line.toolCallId);
        if (existing !== undefined && chat[existing]?.role === "tool") {
          const previous = chat[existing]!;
          chat[existing] = {
            ...previous,
            ...line,
            args: line.args ?? previous.args,
          };
          continue;
        }
        toolCallIndices.set(line.toolCallId, chat.length);
      }
      chat.push(line);
    }
  }
  return chat;
}

function assistantMessageToChatLines(
  message: AssistantMessage,
  runtimeTab: RuntimeTab,
): ChatLine[] {
  return message.content.flatMap((block): ChatLine[] => {
    if (block.type === "text") {
      const text = assistantText([block]);
      return text.trim() ? [{ role: "assistant", text }] : [];
    }
    if (block.type === "thinking") {
      const text = block.redacted ? "[Reasoning redacted]" : block.thinking;
      return text.trim() ? [{ role: "thinking", text }] : [];
    }
    if (block.type === "toolCall") {
      return [
        toolExecutionToChatLine(runtimeTab, {
          toolCallId: block.id,
          toolName: block.name || "unknown",
          status: "pending",
          text: "",
          args: block.arguments ?? {},
          isPartial: true,
        }),
      ];
    }
    return [];
  });
}

export function appendPreviewMessage(
  tab: MixCodeTabInfo,
  role: PreviewMessageRole,
  text: string,
): number | undefined {
  if (!text.trim()) return undefined;
  const index = tab.previewMessages.push({ role, text }) - 1;
  tab.previewIndex = index;
  return index;
}

export function updatePreviewMessage(
  tab: MixCodeTabInfo,
  index: number | undefined,
  role: PreviewMessageRole,
  text: string,
): number | undefined {
  if (!text.trim()) return index;
  if (index !== undefined && tab.previewMessages[index]) {
    tab.previewMessages[index] = { role, text };
    tab.previewIndex = index;
    return index;
  }
  return appendPreviewMessage(tab, role, text);
}

export function syncPreviewFromChat(tab: MixCodeTabInfo, chat: ChatLine[]): void {
  tab.previewMessages = chat.map((line) => ({
    role: previewRoleForChatLine(line),
    text: line.text,
  }));
  tab.previewIndex = Math.max(0, tab.previewMessages.length - 1);
}

export function syncContextUsage(runtimeTab: RuntimeTab): void {
  // Context usage is a display-only metric. A degenerate/restored history entry
  // (e.g. a toolCall block with no arguments) can make the SDK's token
  // estimator throw; that must not make the tab uncreatable or break a render.
  // When the SDK can't compute usage we keep whatever the last event set —
  // clobbering to undefined would discard data from applyAssistantUsage.
  let usage: ReturnType<RuntimeTab["agentSession"]["getContextUsage"]>;
  try {
    usage = runtimeTab.agentSession.getContextUsage();
  } catch {
    return;
  }
  // Only sync contextLimit from runtime if the user hasn't overridden it
  if (!runtimeTab.tab.contextLimitOverridden) {
    runtimeTab.tab.contextLimit = usage?.contextWindow ?? runtimeTab.tab.contextLimit;
  }
  if (usage?.tokens != null && usage.tokens > 0) {
    runtimeTab.tab.currentContextTokens = usage.tokens;
  }
}

export function contextTokensFromUsage(usage: Partial<Usage>): number | undefined {
  const total =
    usage.totalTokens ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return total > 0 ? total : undefined;
}

function previewRoleForChatLine(line: ChatLine): PreviewMessageRole {
  return line.role === "extension" ? "system" : line.role;
}

export function resetTabForNewSession(tab: MixCodeTabInfo, sessionId: string): void {
  tab.sessionId = sessionId;
  tab.status = "idle";
  tab.tokenInput = 0;
  tab.tokenOutput = 0;
  tab.currentContextTokens = undefined;
  tab.pendingDialogs = [];
  tab.pendingMessages = [];
  tab.pendingFollowUps = [];
  tab.chatScrollOffset = 0;
  tab.chatScrollAnchorEntryId = undefined;
  tab.chatScrollAnchorIndex = undefined;
  tab.chatScrollAnchorText = undefined;
  discardVimTranscriptSearch(tab);
  tab.previewMessages = [];
  tab.previewIndex = 0;
  tab.previewScrollOffset = 0;
  tab.previewHint = "";
  clearPendingEscape(tab);
  tab.unreadDone = false;
  tab.workingStartedAt = undefined;
  tab.lastWorkedDurationSeconds = undefined;
  tab.lastWorkedAt = undefined;
  tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    waitingForInputs: [],
    workingVisible: true,
  };
  // The startup header belongs to the outgoing session's services; every
  // session-replacement path recomputes it via refreshStartupHeader.
  tab.startupSummary = undefined;
  tab.startupSummaryCompact = undefined;
}

export function applyRuntimeTabModel(runtimeTab: RuntimeTab, model: MixCodeModel): void {
  runtimeTab.tab.model = modelToRef(model);
  runtimeTab.tab.contextLimit = model.contextWindow;
  runtimeTab.tab.contextLimitOverridden = false;
}

export async function emitBeforeSwitch(
  runtimeTab: RuntimeTab,
  reason: "new" | "resume",
  targetSessionFile?: string,
): Promise<{ cancelled: boolean }> {
  const runner = runtimeTab.agentSession.extensionRunner;
  if (!runner.hasHandlers("session_before_switch")) return { cancelled: false };
  const result = await runner.emit({ type: "session_before_switch", reason, targetSessionFile });
  return { cancelled: result?.cancel === true };
}

export async function emitBeforeFork(
  runtimeTab: RuntimeTab,
  entryId: string,
  position: "before" | "at",
): Promise<{ cancelled: boolean }> {
  const runner = runtimeTab.agentSession.extensionRunner;
  if (!runner.hasHandlers("session_before_fork")) return { cancelled: false };
  const result = await runner.emit({ type: "session_before_fork", entryId, position });
  return { cancelled: result?.cancel === true };
}

export function hasPriorVisibleConversation(entries: SessionEntry[]): boolean {
  return entries.some((entry) => {
    if (entry.type === "custom_message") return entry.display;
    return (
      entry.type === "message" &&
      (entry.message.role === "user" ||
        entry.message.role === "assistant" ||
        entry.message.role === "toolResult" ||
        entry.message.role === "bashExecution" ||
        entry.message.role === "custom")
    );
  });
}

export async function inspectSessionImport(
  inputPath: string,
  cwdOverride: string | undefined,
  fallbackCwd: string,
): Promise<{ resolvedPath: string; sessionId: string }> {
  const resolvedPath = path.resolve(inputPath);
  let content: string;
  try {
    content = await Bun.file(resolvedPath).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Session import file not found: ${resolvedPath}`);
    }
    throw error;
  }
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw new Error(`Session import file is empty: ${resolvedPath}`);
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch (error) {
    throw new Error(
      `Session import header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !header ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    (header as { type?: unknown }).type !== "session"
  ) {
    throw new Error("Session import file must start with a session header");
  }
  const cwd = (header as { cwd?: unknown }).cwd;
  if (!cwdOverride) {
    if (typeof cwd !== "string" || !cwd.trim()) {
      throw new Error("Session import requires a cwd override because the JSONL header has no cwd");
    }
    // Directory existence: Bun.file().exists() is file-only (returns false for dirs).
    if (!fs.existsSync(cwd)) {
      throw new Error(
        `Stored session working directory does not exist: ${cwd}\nSession file: ${resolvedPath}\nCurrent working directory: ${fallbackCwd}`,
      );
    }
  }
  const sessionId = (header as { id?: unknown }).id;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("Session import header is missing a valid session id");
  }
  return { resolvedPath, sessionId };
}

export function drainPendingMessages(
  messages: string[],
  count?: number,
): { start: number; items: string[] } {
  if (count === undefined) return { start: 0, items: messages.splice(0) };
  const start = Math.max(0, messages.length - count);
  return { start, items: messages.splice(start, count) };
}
