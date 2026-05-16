import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { consumeGoalCompletionMarker } from "../core/goal.js";
import {
  appendEmptyRunNotice,
  appendPreviewMessage,
  assistantDisplayText,
  contextTokensFromUsage,
  customMessageToChatLine,
  elapsedSeconds,
  surfaceAssistantStopReason,
  syncContextUsage,
  updatePreviewMessage,
} from "./runtime-chat.js";
import { contentText } from "./runtime-text.js";
import {
  formatToolPreview,
  normalizeToolResult,
  summarizeToolContent,
  summarizeToolResult,
  summarizeUnknown,
  toolExecutionToChatLine,
} from "./runtime-tool-chat.js";
import type { ChatLine, RuntimeEvent, RuntimeTab, ToolResultLike } from "./runtime-types.js";

export function applyEvent(
  runtimeTab: RuntimeTab,
  event: RuntimeEvent,
  emitChange: (event: RuntimeEvent, runtimeTab: RuntimeTab) => void,
): void {
  if (event.type === "queue_update") {
    syncQueueState(runtimeTab, event.steering);
    emitChange(event, runtimeTab);
    return;
  }
  switch (event.type) {
    case "agent_start":
      runtimeTab.currentRunChatStartIndex = runtimeTab.chat.length;
      runtimeTab.tab.status = "running";
      runtimeTab.tab.workingStartedAt = new Date().toISOString();
      runtimeTab.tab.lastWorkedDurationSeconds = undefined;
      runtimeTab.tab.pendingEscapeAction = undefined;
      runtimeTab.tab.pendingEscapeArmedAt = undefined;
      break;
    case "turn_start":
      runtimeTab.currentRunChatStartIndex ??= runtimeTab.chat.length;
      runtimeTab.tab.status = "thinking";
      runtimeTab.tab.workingStartedAt ??= new Date().toISOString();
      runtimeTab.tab.lastWorkedDurationSeconds = undefined;
      break;
    case "agent_end":
      appendEmptyRunNotice(runtimeTab);
      runtimeTab.tab.status = "idle";
      runtimeTab.tab.unreadDone = true;
      runtimeTab.tab.pendingEscapeAction = undefined;
      runtimeTab.tab.pendingEscapeArmedAt = undefined;
      runtimeTab.tab.lastWorkedDurationSeconds = elapsedSeconds(
        runtimeTab.tab.workingStartedAt,
        new Date(),
      );
      runtimeTab.tab.workingStartedAt = undefined;
      runtimeTab.streamingReasoning = undefined;
      runtimeTab.currentRunChatStartIndex = undefined;
      break;
    case "message_start":
      appendMessageStart(runtimeTab, event.message);
      break;
    case "message_update":
      if (event.message.role === "assistant") {
        updateStreamingAssistant(runtimeTab, event.message);
        updateStreamingReasoningFromMessage(runtimeTab, event.message);
      }
      break;
    case "tool_execution_start":
      runtimeTab.reasoning.push(`${event.toolName} started`);
      upsertToolExecution(runtimeTab, event.toolCallId, event.toolName, "running", "", event.args);
      break;
    case "tool_execution_update":
      runtimeTab.reasoning.push(`${event.toolName} update`);
      upsertToolExecution(
        runtimeTab,
        event.toolCallId,
        event.toolName,
        "running",
        `update ${summarizeUnknown(event.partialResult)}`,
        undefined,
        normalizeToolResult(event.partialResult, false),
        true,
      );
      break;
    case "tool_execution_end":
      upsertToolExecution(
        runtimeTab,
        event.toolCallId,
        event.toolName,
        event.isError ? "error" : "success",
        summarizeToolResult(event.result, event.isError),
        undefined,
        normalizeToolResult(event.result, event.isError),
        false,
      );
      break;
    case "message_end":
      if (event.message.role === "assistant") {
        updateStreamingReasoningFromMessage(runtimeTab, event.message);
        updateStreamingAssistant(runtimeTab, event.message, { final: true });
        surfaceAssistantStopReason(runtimeTab, event.message);
      }
      runtimeTab.streamingReasoning = undefined;
      break;
    case "turn_end":
      break;
    case "compaction_start":
      runtimeTab.tab.status = "running";
      runtimeTab.tab.workingStartedAt = new Date().toISOString();
      runtimeTab.tab.lastWorkedDurationSeconds = undefined;
      runtimeTab.tab.pendingEscapeAction = undefined;
      runtimeTab.tab.pendingEscapeArmedAt = undefined;
      runtimeTab.chat.push({ role: "system", text: `Compaction started (${event.reason}).` });
      break;
    case "compaction_end":
      runtimeTab.tab.status = event.errorMessage ? "error" : "idle";
      runtimeTab.tab.pendingEscapeAction = undefined;
      runtimeTab.tab.pendingEscapeArmedAt = undefined;
      runtimeTab.tab.lastWorkedDurationSeconds = elapsedSeconds(
        runtimeTab.tab.workingStartedAt,
        new Date(),
      );
      runtimeTab.tab.workingStartedAt = undefined;
      if (!event.errorMessage) {
        runtimeTab.tab.unreadDone = true;
        syncContextUsage(runtimeTab);
      }
      if (event.errorMessage)
        runtimeTab.chat.push({
          role: "system",
          text: `Compaction failed: ${event.errorMessage}`,
        });
      break;
    case "session_info_changed":
      if (event.name) runtimeTab.tab.title = event.name;
      break;
    case "thinking_level_changed":
      runtimeTab.tab.thinkingLevel = event.level;
      break;
    case "auto_retry_start":
      runtimeTab.chat.push({
        role: "system",
        text: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
      });
      break;
    case "auto_retry_end":
      if (!event.success)
        runtimeTab.chat.push({
          role: "system",
          text: `Retry failed: ${event.finalError ?? "unknown error"}`,
        });
      break;
  }
  emitChange(event, runtimeTab);
}

export function syncQueueState(runtimeTab: RuntimeTab, steering: readonly string[]): void {
  const preserved = runtimeTab.tab.pendingMessages.slice(
    0,
    Math.max(0, runtimeTab.tab.pendingMessages.length - runtimeTab.queuedPromptCount),
  );
  runtimeTab.tab.pendingMessages = [...preserved, ...steering];
  runtimeTab.queuedPromptCount = steering.length;
}

export function appendMessageStart(runtimeTab: RuntimeTab, message: AgentMessage): void {
  if (message.role === "user") {
    const text = contentText(message.content);
    if (!text.trim()) return;
    runtimeTab.tab.chatScrollOffset = 0;
    runtimeTab.chat.push({ role: "user", text });
    appendPreviewMessage(runtimeTab.tab, "user", text);
  } else if (message.role === "custom") {
    const line = customMessageToChatLine(message, runtimeTab);
    if (!line) return;
    runtimeTab.chat.push(line);
    appendPreviewMessage(runtimeTab.tab, "system", line.text || line.title || "extension message");
  } else if (message.role === "assistant") {
    const indices = syncAssistantBlocks(runtimeTab, message);
    const text = assistantDisplayText(runtimeTab.tab, message);
    const previewIndex = appendPreviewMessage(runtimeTab.tab, "assistant", text);
    runtimeTab.streamingAssistant = {
      chatIndex: indices.chatIndex,
      blockIndices: indices.blockIndices,
      toolCallIndices: indices.toolCallIndices,
      previewIndex,
      tokenInput: 0,
      tokenOutput: 0,
    };
    applyAssistantUsage(runtimeTab, message.usage);
  } else if (message.role === "toolResult") {
    updateExistingToolExecution(
      runtimeTab,
      message.toolCallId,
      message.toolName,
      message.isError ? "error" : "success",
      summarizeToolContent(message.content, message.isError),
      normalizeToolResult(message, message.isError),
    );
    appendPreviewMessage(
      runtimeTab.tab,
      "tool",
      formatToolPreview(message.toolName, message.content, message.isError),
    );
  }
}

export function updateStreamingAssistant(
  runtimeTab: RuntimeTab,
  message: AssistantMessage,
  options: { final?: boolean } = {},
): void {
  const text = assistantDisplayText(runtimeTab.tab, message);
  let streaming = runtimeTab.streamingAssistant;
  if (!streaming) {
    const indices = syncAssistantBlocks(runtimeTab, message);
    const previewIndex = appendPreviewMessage(runtimeTab.tab, "assistant", text);
    streaming = {
      chatIndex: indices.chatIndex,
      blockIndices: indices.blockIndices,
      toolCallIndices: indices.toolCallIndices,
      previewIndex,
      tokenInput: 0,
      tokenOutput: 0,
    };
    runtimeTab.streamingAssistant = streaming;
  } else {
    const indices = syncAssistantBlocks(runtimeTab, message, streaming);
    streaming.chatIndex = indices.chatIndex;
    streaming.blockIndices = indices.blockIndices;
    streaming.toolCallIndices = indices.toolCallIndices;
    streaming.previewIndex = updatePreviewMessage(
      runtimeTab.tab,
      streaming.previewIndex,
      "assistant",
      text,
    );
  }
  applyAssistantUsage(runtimeTab, message.usage);
  if (options.final) {
    runtimeTab.streamingAssistant = undefined;
  }
}

export function updateStreamingReasoningFromMessage(
  runtimeTab: RuntimeTab,
  message: AssistantMessage,
): void {
  message.content.forEach((block, contentIndex) => {
    if (block.type === "thinking") {
      upsertStreamingReasoning(runtimeTab, contentIndex, block.thinking);
    }
  });
}

export function upsertStreamingReasoning(
  runtimeTab: RuntimeTab,
  contentIndex: number,
  text: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const streaming = runtimeTab.streamingReasoning ?? { entries: new Map<number, number>() };
  runtimeTab.streamingReasoning = streaming;
  const existing = streaming.entries.get(contentIndex);
  if (existing !== undefined && runtimeTab.reasoning[existing] !== undefined) {
    runtimeTab.reasoning[existing] = trimmed;
    return;
  }
  const reasoningIndex = runtimeTab.reasoning.push(trimmed) - 1;
  streaming.entries.set(contentIndex, reasoningIndex);
}

export function syncAssistantBlocks(
  runtimeTab: RuntimeTab,
  message: AssistantMessage,
  streaming?: RuntimeTab["streamingAssistant"],
): {
  chatIndex?: number;
  blockIndices: Map<number, number>;
  toolCallIndices: Map<string, number>;
} {
  const blockIndices = new Map(streaming?.blockIndices ?? []);
  const toolCallIndices = new Map(streaming?.toolCallIndices ?? []);
  let chatIndex = streaming?.chatIndex;
  message.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      const text =
        contentIndex === 0 ? consumeGoalCompletionMarker(runtimeTab.tab, block.text) : block.text;
      if (!text.trim()) return;
      const existing = blockIndices.get(contentIndex);
      if (existing !== undefined && runtimeTab.chat[existing]?.role === "assistant") {
        runtimeTab.chat[existing] = { role: "assistant", text };
        chatIndex = existing;
        return;
      }
      if (
        chatIndex !== undefined &&
        runtimeTab.chat[chatIndex]?.role === "assistant" &&
        !runtimeTab.chat[chatIndex]?.text.trim()
      ) {
        runtimeTab.chat[chatIndex] = { role: "assistant", text };
        blockIndices.set(contentIndex, chatIndex);
        return;
      }
      const index = runtimeTab.chat.push({ role: "assistant", text }) - 1;
      blockIndices.set(contentIndex, index);
      chatIndex = index;
      return;
    }
    if (block.type === "thinking") {
      const thinking = block.redacted ? "[Reasoning redacted]" : block.thinking;
      if (!thinking.trim()) return;
      const existing = blockIndices.get(contentIndex);
      if (existing !== undefined && runtimeTab.chat[existing]?.role === "thinking") {
        runtimeTab.chat[existing] = { role: "thinking", text: thinking };
        return;
      }
      blockIndices.set(
        contentIndex,
        runtimeTab.chat.push({ role: "thinking", text: thinking }) - 1,
      );
      return;
    }
    if (block.type === "toolCall") {
      const title = block.name || "unknown";
      const text = "";
      const existing = toolCallIndices.get(block.id) ?? blockIndices.get(contentIndex);
      const previous =
        existing !== undefined && runtimeTab.chat[existing]?.role === "tool"
          ? runtimeTab.chat[existing]
          : undefined;
      const line = toolExecutionToChatLine(runtimeTab, {
        toolCallId: block.id,
        toolName: title,
        status: "pending",
        text,
        args: block.arguments,
        isPartial: true,
        previous,
      });
      if (existing !== undefined && runtimeTab.chat[existing]?.role === "tool") {
        runtimeTab.chat[existing] = line;
        blockIndices.set(contentIndex, existing);
        if (block.id) toolCallIndices.set(block.id, existing);
        return;
      }
      const index = runtimeTab.chat.push(line) - 1;
      blockIndices.set(contentIndex, index);
      if (block.id) toolCallIndices.set(block.id, index);
    }
  });
  return { chatIndex, blockIndices, toolCallIndices };
}

export function upsertToolExecution(
  runtimeTab: RuntimeTab,
  toolCallId: string,
  toolName: string,
  status: ChatLine["status"],
  text: string,
  args?: unknown,
  result?: ToolResultLike,
  isPartial = status === "running",
): void {
  const streaming = runtimeTab.streamingAssistant;
  const existing =
    streaming?.toolCallIndices.get(toolCallId) ??
    runtimeTab.chat.findIndex((line) => line.role === "tool" && line.toolCallId === toolCallId);
  const previous =
    existing >= 0 && runtimeTab.chat[existing]?.role === "tool"
      ? runtimeTab.chat[existing]
      : undefined;
  const line = toolExecutionToChatLine(runtimeTab, {
    toolCallId,
    toolName: toolName || "unknown",
    status,
    text,
    args: args ?? previous?.args,
    result,
    isPartial,
    previous,
  });
  if (existing >= 0 && runtimeTab.chat[existing]?.role === "tool") {
    runtimeTab.chat[existing] = line;
    streaming?.toolCallIndices.set(toolCallId, existing);
    return;
  }
  const index = runtimeTab.chat.push(line) - 1;
  streaming?.toolCallIndices.set(toolCallId, index);
}

function updateExistingToolExecution(
  runtimeTab: RuntimeTab,
  toolCallId: string,
  toolName: string,
  status: ChatLine["status"],
  text: string,
  result: ToolResultLike | undefined,
): void {
  const streaming = runtimeTab.streamingAssistant;
  const existing =
    streaming?.toolCallIndices.get(toolCallId) ??
    runtimeTab.chat.findIndex((line) => line.role === "tool" && line.toolCallId === toolCallId);
  if (existing < 0 || runtimeTab.chat[existing]?.role !== "tool") return;
  const previous = runtimeTab.chat[existing]!;
  const resolvedToolName = toolName || previous.title || "unknown";
  runtimeTab.chat[existing] = toolExecutionToChatLine(runtimeTab, {
    toolCallId,
    toolName: resolvedToolName,
    status,
    text,
    args: previous.args,
    result,
    isPartial: false,
    previous,
  });
  streaming?.toolCallIndices.set(toolCallId, existing);
}

export function applyAssistantUsage(runtimeTab: RuntimeTab, usage: Partial<Usage>): void {
  const streaming = runtimeTab.streamingAssistant;
  if (!streaming) {
    runtimeTab.tab.tokenInput += usage.input ?? 0;
    runtimeTab.tab.tokenOutput += usage.output ?? 0;
    runtimeTab.tab.currentContextTokens =
      contextTokensFromUsage(usage) ?? runtimeTab.tab.currentContextTokens;
    return;
  }
  const nextInput = usage.input ?? 0;
  const nextOutput = usage.output ?? 0;
  runtimeTab.tab.tokenInput += nextInput - streaming.tokenInput;
  runtimeTab.tab.tokenOutput += nextOutput - streaming.tokenOutput;
  streaming.tokenInput = nextInput;
  streaming.tokenOutput = nextOutput;
  runtimeTab.tab.currentContextTokens =
    contextTokensFromUsage(usage) ?? runtimeTab.tab.currentContextTokens;
}
