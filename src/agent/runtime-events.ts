import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  appendEmptyRunNotice,
  appendPreviewMessage,
  appendSystemMessage,
  assistantText,
  contextTokensFromUsage,
  customEntryToChatLine,
  customMessageToChatLine,
  disposeChatRenderers,
  entriesToChatLines,
  surfaceAssistantStopReason,
  syncContextUsage,
  syncPreviewFromChat,
  updatePreviewMessage,
} from "./runtime-chat.js";
import { clearPendingEscape } from "../core/escape.js";
import {
  addTabTokens,
  setTabContextTokens,
  setPendingFollowUps,
  setPendingMessages,
  setTabStatus,
} from "../core/tab-state.js";
import {
  contentImages,
  userMessageText,
  formatToolPreview,
  normalizeToolResult,
  summarizeToolContent,
  summarizeToolResult,
  summarizeUnknown,
  toolExecutionToChatLine,
} from "./runtime-tool-chat.js";
import { clearChatScrollAnchor } from "../core/overlays.js";
import type { ChatLine, RuntimeEvent, RuntimeTab, ToolResultLike } from "./runtime-types.js";

function normalizeCompactionFailureMessage(message: string): string {
  return /^(Auto-)?Compaction failed:/i.test(message) ? message : `Compaction failed: ${message}`;
}

/**
 * Consume the one-shot SDK continuation marker. Reading it always clears it so
 * a marker from an interrupted continuation cannot leak into a later fresh run.
 */
function consumeSdkRunContinuation(runtimeTab: RuntimeTab): boolean {
  const continuation = runtimeTab.sdkRunContinuation === true;
  runtimeTab.sdkRunContinuation = false;
  return continuation;
}

export function applyEvent(
  runtimeTab: RuntimeTab,
  event: RuntimeEvent,
  emitChange: (event: RuntimeEvent, runtimeTab: RuntimeTab) => void,
): void {
  if (event.type === "queue_update") {
    syncQueueState(runtimeTab, event.steering, event.followUp);
    emitChange(event, runtimeTab);
    return;
  }
  switch (event.type) {
    case "agent_start": {
      runtimeTab.currentRunChatStartIndex = runtimeTab.chat.length;
      runtimeTab.postRunWorkingStartedAt = undefined;
      // Consume the marker unconditionally (no short-circuit leak).
      const sdkContinuation = consumeSdkRunContinuation(runtimeTab);
      // Fresh run restarts the timer; continuations of the same perceived work
      // preserve it: auto-retry (retryInfo still armed) and SDK compact-and-retry
      // continue (willRetry marker).
      setTabStatus(runtimeTab.tab, "running", {
        restart: !runtimeTab.tab.retryInfo && !sdkContinuation,
      });
      clearPendingEscape(runtimeTab.tab);
      break;
    }
    case "turn_start":
      runtimeTab.currentRunChatStartIndex ??= runtimeTab.chat.length;
      setTabStatus(runtimeTab.tab, "thinking");
      break;
    case "agent_end":
      // Core only maps Pi-native agent_end → idle / queue flush.
      appendEmptyRunNotice(runtimeTab);
      // Pi moves streaming-started user bash from the pending area into chat on
      // the next normal submit; agent_end is the earliest stable point here.
      flushPendingUserBashLines(runtimeTab);
      // Save the start stamp for SDK post-run compaction before the timer closes.
      runtimeTab.postRunWorkingStartedAt = runtimeTab.tab.workingStartedAt;
      setTabStatus(runtimeTab.tab, "idle");
      runtimeTab.tab.unreadDone = true;
      clearPendingEscape(runtimeTab.tab);
      runtimeTab.currentRunChatStartIndex = undefined;
      break;
    case "message_start":
      appendMessageStart(runtimeTab, event.message);
      break;
    case "message_update":
      if (event.message.role === "assistant") {
        updateStreamingAssistant(runtimeTab, event.message);
      }
      break;
    case "tool_execution_start":
      upsertToolExecution(runtimeTab, event.toolCallId, event.toolName, "running", "", event.args);
      break;
    case "tool_execution_update":
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
        updateStreamingAssistant(runtimeTab, event.message, { final: true });
        surfaceAssistantStopReason(runtimeTab, event.message);
      }
      break;
    case "turn_end":
      break;
    case "bash_execution_update":
      break;
    case "compaction_start":
      runtimeTab.tab.activeCompactionReason = event.reason;
      // SDK post-run auto-compaction starts after agent_end clears the active timer.
      // Preserve an existing stamp; otherwise reuse the post-run start or stamp now.
      {
        const postRunStartedAt =
          event.reason === "manual" ? undefined : runtimeTab.postRunWorkingStartedAt;
        setTabStatus(runtimeTab.tab, "running", {
          startedAt:
            runtimeTab.tab.workingStartedAt ?? postRunStartedAt ?? new Date().toISOString(),
        });
        runtimeTab.postRunWorkingStartedAt = undefined;
      }
      clearPendingEscape(runtimeTab.tab);
      // Pi uses CompactionStatusIndicator (spinner), not a chat status line.
      // MixCode already shows the working loader while status is running.
      break;
    case "compaction_end": {
      // SDK compact-and-retry (willRetry) calls agent.continue() after this event.
      runtimeTab.tab.activeCompactionReason = undefined;
      const sdkWillContinue = Boolean(event.result && event.willRetry);
      if (sdkWillContinue) runtimeTab.sdkRunContinuation = true;
      const nextStatus: typeof runtimeTab.tab.status = event.errorMessage
        ? "error"
        : sdkWillContinue
          ? "running"
          : "idle";
      // Continuation keeps the timer running; a real end closes it into a duration.
      setTabStatus(runtimeTab.tab, nextStatus, {
        preserveStartedAt: sdkWillContinue,
      });
      clearPendingEscape(runtimeTab.tab);
      if (event.result) {
        // Rebuild chat from session entries (which now include the compaction entry)
        disposeChatRenderers(runtimeTab.chat);
        runtimeTab.chat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
        syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
        syncContextUsage(runtimeTab);
        if (!sdkWillContinue) {
          runtimeTab.tab.unreadDone = true;
        }
      } else if (event.errorMessage) {
        appendSystemMessage(
          runtimeTab,
          normalizeCompactionFailureMessage(event.errorMessage),
          "error",
        );
      } else if (event.aborted) {
        appendSystemMessage(runtimeTab, "Compaction cancelled.");
      }
      break;
    }
    case "entry_appended": {
      // CustomEntry from pi.appendEntry — not LLM context; show via EntryRenderer.
      if (event.entry.type === "custom") {
        const line = customEntryToChatLine(event.entry, runtimeTab);
        if (line) {
          runtimeTab.chat.push(line);
          appendPreviewMessage(
            runtimeTab.tab,
            "system",
            line.text || line.title || "extension entry",
          );
        }
      }
      break;
    }
    case "session_info_changed":
      if (event.name) runtimeTab.tab.title = event.name;
      break;
    case "thinking_level_changed":
      runtimeTab.tab.thinkingLevel = event.level;
      break;
    case "auto_retry_start":
      // agent_end already closed the timer before the SDK decided to retry.
      // Restore the just-ended run's stamp (mirror compaction_start) so the
      // retry countdown and its continuation keep counting from the original
      // prompt instead of re-zeroing the spinner elapsed time.
      setTabStatus(runtimeTab.tab, "thinking", {
        startedAt:
          runtimeTab.tab.workingStartedAt ??
          runtimeTab.postRunWorkingStartedAt ??
          new Date().toISOString(),
      });
      runtimeTab.postRunWorkingStartedAt = undefined;
      runtimeTab.tab.retryInfo = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        startedAt: Date.now(),
      };
      // Pi uses RetryStatusIndicator (countdown spinner). MixCode already surfaces
      // the live countdown via retryStatusMessage in the working loader — do not
      // also dump a chat line on every attempt.
      break;
    case "auto_retry_end":
      runtimeTab.tab.retryInfo = undefined;
      if (!event.success) {
        // No continuation follows a failed/cancelled retry. Close the restored
        // timer into a measured duration unless another path (abortTab's retry
        // branch, or the final attempt's agent_end) already left the working
        // state and recorded it.
        if (runtimeTab.tab.status === "running" || runtimeTab.tab.status === "thinking") {
          setTabStatus(runtimeTab.tab, "idle");
        }
        // Pi showError on final retry failure — permanent chat line.
        appendSystemMessage(
          runtimeTab,
          `Error: Retry failed: ${event.finalError ?? "unknown error"}`,
        );
      }
      break;
    case "summarization_retry_scheduled":
      // Pi interactive: showError(errorMessage) + RetryStatusIndicator countdown.
      // Reuse tab.retryInfo so the existing working-loader countdown path ticks.
      setTabStatus(runtimeTab.tab, "thinking", {
        startedAt:
          runtimeTab.tab.workingStartedAt ??
          runtimeTab.postRunWorkingStartedAt ??
          new Date().toISOString(),
      });
      runtimeTab.postRunWorkingStartedAt = undefined;
      runtimeTab.tab.retryInfo = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        startedAt: Date.now(),
      };
      appendSystemMessage(runtimeTab, event.errorMessage, "error");
      break;
    case "summarization_retry_attempt_start":
      // Pi clears the retry indicator and shows compaction/branch-summary spinner.
      // MixCode already keeps status running/thinking during those operations.
      runtimeTab.tab.retryInfo = undefined;
      if (runtimeTab.tab.status === "idle") {
        setTabStatus(runtimeTab.tab, "running");
      }
      break;
    case "summarization_retry_finished":
      runtimeTab.tab.retryInfo = undefined;
      break;
  }
  emitChange(event, runtimeTab);
}

export function syncQueueState(
  runtimeTab: RuntimeTab,
  steering: readonly string[],
  followUp: readonly string[] = [],
): void {
  // Local UI can unshift drafts ahead of the runtime-mirrored tail; preserve that prefix.
  const preservedSteer = runtimeTab.tab.pendingMessages.slice(
    0,
    Math.max(0, runtimeTab.tab.pendingMessages.length - runtimeTab.queuedPromptCount),
  );
  setPendingMessages(runtimeTab.tab, [...preservedSteer, ...steering]);
  runtimeTab.queuedPromptCount = steering.length;

  const preservedFollowUp = runtimeTab.tab.pendingFollowUps.slice(
    0,
    Math.max(0, runtimeTab.tab.pendingFollowUps.length - runtimeTab.queuedFollowUpCount),
  );
  setPendingFollowUps(runtimeTab.tab, [...preservedFollowUp, ...followUp]);
  runtimeTab.queuedFollowUpCount = followUp.length;
}

export function appendMessageStart(runtimeTab: RuntimeTab, message: AgentMessage): void {
  if (message.role === "user") {
    // Pi getUserMessageText + separate image blocks for TUI.
    const text = userMessageText(message.content);
    const images = contentImages(message.content);
    if (!text.trim() && images.length === 0) return;
    clearChatScrollAnchor(runtimeTab.tab);
    runtimeTab.tab.chatScrollOffset = 0;
    runtimeTab.chat.push({
      role: "user",
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? { timestamp: message.timestamp }
        : {}),
    });
    appendPreviewMessage(runtimeTab.tab, "user", text.trim() || "[image]");
  } else if (message.role === "custom") {
    const line = customMessageToChatLine(message, runtimeTab);
    if (!line) return;
    runtimeTab.chat.push(line);
    appendPreviewMessage(runtimeTab.tab, "system", line.text || line.title || "extension message");
  } else if (message.role === "assistant") {
    const indices = syncAssistantBlocks(runtimeTab, message);
    const text = assistantText(message.content);
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
  const text = assistantText(message.content);
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
      const text = block.text;
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
    addTabTokens(runtimeTab.tab, { input: usage.input ?? 0, output: usage.output ?? 0 });
    setTabContextTokens(
      runtimeTab.tab,
      contextTokensFromUsage(usage) ?? runtimeTab.tab.currentContextTokens,
    );
    return;
  }
  const nextInput = usage.input ?? 0;
  const nextOutput = usage.output ?? 0;
  addTabTokens(runtimeTab.tab, {
    input: nextInput - streaming.tokenInput,
    output: nextOutput - streaming.tokenOutput,
  });
  streaming.tokenInput = nextInput;
  streaming.tokenOutput = nextOutput;
  setTabContextTokens(
    runtimeTab.tab,
    contextTokensFromUsage(usage) ?? runtimeTab.tab.currentContextTokens,
  );
}

/** Pi parity: promote deferred user-bash blocks into normal chat after the agent turn. */
function flushPendingUserBashLines(runtimeTab: RuntimeTab): void {
  for (const line of runtimeTab.chat) {
    if (line.role === "tool" && line.variant === "user-bash" && line.pendingBash) {
      line.pendingBash = undefined;
    }
  }
}
