import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { MessageRenderer, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Component, TUI as PiTui } from "@earendil-works/pi-tui";
import type { MixCodeTabInfo, PreviewMessageRole } from "../core/types.js";
import { clearPendingEscape } from "../core/tab-state.js";
import { MIXCODE_EXTENSION_THEME } from "./runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "./runtime-pi-tui-bridge.js";
import { NullTerminal } from "./runtime-null-terminal.js";
import { contentText } from "./runtime-text.js";
import {
  normalizeToolResult,
  summarizeToolContent,
  toolExecutionToChatLine,
} from "./runtime-tool-chat.js";
import type { ChatLine, CustomMessageLike, RuntimeTab } from "./runtime-types.js";

export function assistantDisplayText(_tab: MixCodeTabInfo, message: AssistantMessage): string {
  return assistantText(message.content);
}

export function appendSystemMessage(runtimeTab: RuntimeTab, text: string): void {
  if (!text.trim()) return;
  runtimeTab.chat.push({ role: "system", text });
  appendPreviewMessage(runtimeTab.tab, "system", text);
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
  if (!text) return;
  const pendingToolIndices = runtimeTab.chat
    .map((line, index) => ({ line, index }))
    .filter(
      (item) =>
        item.line.role === "tool" &&
        (item.line.status === "pending" || item.line.status === "running"),
    )
    .map((item) => item.index);
  if (pendingToolIndices.length) {
    for (const index of pendingToolIndices) {
      const line = runtimeTab.chat[index];
      if (line?.role !== "tool") continue;
      runtimeTab.chat[index] = { ...line, status: "error", text };
    }
    return;
  }
  if (!assistantText(message.content).trim()) {
    appendSystemMessage(runtimeTab, text);
  }
}

function assistantStopReasonText(message: AssistantMessage): string {
  if (message.stopReason === "aborted") {
    return message.errorMessage && message.errorMessage !== "Request was aborted"
      ? message.errorMessage
      : "Operation aborted";
  }
  if (message.stopReason === "error") {
    return `Error: ${message.errorMessage || "Unknown error"}`;
  }
  return "";
}

export function customMessageToChatLine(
  message: AgentMessage,
  runtimeTab: RuntimeTab,
): ChatLine | undefined {
  if (!isCustomMessage(message)) return undefined;
  if (!message.display) return undefined;
  const text = contentText(message.content);
  const title = message.customType ? `extension ${message.customType}` : "extension";
  const renderer = runtimeTab.agentSession.extensionRunner.getMessageRenderer(message.customType);
  const line: ChatLine = {
    role: "extension",
    title,
    customType: message.customType,
    text,
  };
  if (renderer) {
    line.renderExtension = (width) =>
      renderPersistentExtensionMessage(line, message, renderer, width);
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
): string[] {
  const terminal = new NullTerminal(Math.max(1, Math.floor(width)));
  const tui = new PiTui(terminal);
  // Mirror mixcode keybindings to every pi-tui module instance so upstream
  // extension renderers see the same manager we do.
  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    const expanded = false;
    if (line.extensionRendererLastComponent && line.extensionRendererExpanded === expanded) {
      return line.extensionRendererLastComponent.render(terminal.columns);
    }
    const component = renderer(message, { expanded }, MIXCODE_EXTENSION_THEME) as
      | (Component & { dispose?(): void })
      | undefined;
    if (line.extensionRendererLastComponent && line.extensionRendererLastComponent !== component) {
      line.extensionRendererLastComponent.dispose?.();
    }
    line.extensionRendererLastComponent = component;
    line.extensionRendererExpanded = expanded;
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
  if (entry.type !== "message") return [];
  const message = entry.message;
  if (message.role === "user") {
    const text = contentText(message.content);
    return text.trim() ? [{ role: "user", text, entryId: entry.id }] : [];
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
  const usage = runtimeTab.agentSession.getContextUsage();
  // Only sync contextLimit from runtime if the user hasn't overridden it
  if (!runtimeTab.tab.contextLimitOverridden) {
    runtimeTab.tab.contextLimit = usage?.contextWindow ?? runtimeTab.tab.contextLimit;
  }
  if (usage?.tokens === null) {
    runtimeTab.tab.currentContextTokens = undefined;
  } else if (usage?.tokens !== undefined && usage.tokens > 0) {
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
  return line.role === "extension" || line.role === "startup" ? "system" : line.role;
}

export function resetTabForNewSession(tab: MixCodeTabInfo, sessionId: string): void {
  tab.sessionId = sessionId;
  tab.status = "idle";
  tab.tokenInput = 0;
  tab.tokenOutput = 0;
  tab.currentContextTokens = undefined;
  tab.pendingDialogs = [];
  tab.pendingMessages = [];
  tab.chatScrollOffset = 0;
  tab.chatScrollAnchorEntryId = undefined;
  tab.chatScrollAnchorIndex = undefined;
  tab.chatScrollAnchorText = undefined;
  tab.previewMessages = [];
  tab.previewIndex = 0;
  tab.previewScrollOffset = 0;
  tab.previewHint = "";
  clearPendingEscape(tab);
  tab.unreadDone = false;
  tab.workingStartedAt = undefined;
  tab.lastWorkedDurationSeconds = undefined;
  tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    pendingUserInteractions: [],
    workingVisible: true,
  };
}

export function applyRuntimeTabModel(runtimeTab: RuntimeTab, model: Model<any>): void {
  runtimeTab.tab.model = {
    provider: model.provider,
    modelId: model.id,
    displayName: `${model.provider}/${model.id}`,
    contextWindow: model.contextWindow,
  };
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

export async function assertImportHasCwd(
  inputPath: string,
  cwdOverride: string | undefined,
  fallbackCwd: string,
): Promise<void> {
  if (cwdOverride) return;
  const firstLine = (await readFile(inputPath, "utf8")).split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw new Error(`Session import file is empty: ${inputPath}`);
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
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Session import requires a cwd override because the JSONL header has no cwd");
  }
  if (!existsSync(cwd)) {
    throw new Error(
      `Stored session working directory does not exist: ${cwd}\nSession file: ${inputPath}\nCurrent working directory: ${fallbackCwd}`,
    );
  }
}

export function drainPendingMessages(
  messages: string[],
  count?: number,
): { start: number; items: string[] } {
  if (count === undefined) return { start: 0, items: messages.splice(0) };
  const start = Math.max(0, messages.length - count);
  return { start, items: messages.splice(start, count) };
}
