import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  appendEmptyRunNotice,
  appendSystemMessage,
  contextTokensFromUsage,
  isNothingToCompactError,
  customEntryToChatLine,
  customMessageToChatLine,
  disposeChatRenderers,
  entriesToChatLines,
  maybeAppendCacheMissNotice,
  surfaceAssistantStopReason,
  syncContextUsage,
} from "./runtime-chat.js";
import { clearPendingEscape } from "../core/escape.js";
import {
  setTabContextTokens,
  setPendingFollowUps,
  setPendingMessages,
  setTabStatus,
} from "../core/tab-state.js";
import {
  contentImages,
  userMessageText,
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
      // This run's prompt is persisted later (at message_end), so the leaf here
      // is the last pre-run entry. Retract uses it to tell this run's own user
      // message apart from an older turn's.
      runtimeTab.currentRunStartLeafId = runtimeTab.session.getLeafId();
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
      runtimeTab.currentRunStartLeafId = undefined;
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
        maybeAppendCacheMissNotice(runtimeTab, event.message);
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
        syncContextUsage(runtimeTab);
        if (!sdkWillContinue) {
          runtimeTab.tab.unreadDone = true;
        }
      } else if (event.errorMessage) {
        // Too-small sessions are a no-op. compactSession posts that notice.
        if (!isNothingToCompactError(event.errorMessage)) {
          appendSystemMessage(
            runtimeTab,
            normalizeCompactionFailureMessage(event.errorMessage),
            "error",
          );
        }
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
  } else if (message.role === "custom") {
    const line = customMessageToChatLine(message, runtimeTab);
    if (!line) return;
    runtimeTab.chat.push(line);
  } else if (message.role === "assistant") {
    const indices = syncAssistantBlocks(runtimeTab, message);
    runtimeTab.streamingAssistant = {
      chatIndex: indices.chatIndex,
      blockIndices: indices.blockIndices,
      toolCallIndices: indices.toolCallIndices,
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
  }
}

export function updateStreamingAssistant(
  runtimeTab: RuntimeTab,
  message: AssistantMessage,
  options: { final?: boolean } = {},
): void {
  let streaming = runtimeTab.streamingAssistant;
  if (!streaming) {
    const indices = syncAssistantBlocks(runtimeTab, message);
    streaming = {
      chatIndex: indices.chatIndex,
      blockIndices: indices.blockIndices,
      toolCallIndices: indices.toolCallIndices,
    };
    runtimeTab.streamingAssistant = streaming;
  } else {
    const indices = syncAssistantBlocks(runtimeTab, message, streaming);
    streaming.chatIndex = indices.chatIndex;
    streaming.blockIndices = indices.blockIndices;
    streaming.toolCallIndices = indices.toolCallIndices;
  }
  applyAssistantUsage(runtimeTab, message.usage);
  if (options.final) {
    stampThinkingEnd(runtimeTab, streaming.blockIndices);
    runtimeTab.streamingAssistant = undefined;
  }
}

/** Freeze the thinking-tail timer on every thinking block of the finished message. */
function stampThinkingEnd(runtimeTab: RuntimeTab, blockIndices: Map<number, number>): void {
  const endedAt = Date.now();
  for (const chatIndex of blockIndices.values()) {
    const line = runtimeTab.chat[chatIndex];
    if (line?.role === "thinking" && line.thinkingEndedAt === undefined) {
      line.thinkingEndedAt = endedAt;
    }
  }
}

/**
 * A non-thinking block after a thinking group means that group stopped
 * growing; freeze its timer without waiting for message_end.
 */
function stampOpenThinkingEnd(runtimeTab: RuntimeTab, chatIndex: number | undefined): void {
  if (chatIndex === undefined) return;
  const line = runtimeTab.chat[chatIndex];
  if (line?.role === "thinking" && line.thinkingEndedAt === undefined) {
    line.thinkingEndedAt = Date.now();
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
  // Chat index of the latest thinking group whose block may still be growing;
  // the first non-thinking block after it freezes its timer.
  let openThinkingIndex: number | undefined;
  message.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      const text = block.text;
      if (!text.trim()) return;
      stampOpenThinkingEnd(runtimeTab, openThinkingIndex);
      openThinkingIndex = undefined;
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
      if (contentIndex > 0 && message.content[contentIndex - 1]?.type === "thinking") {
        // Consecutive thinking blocks render as one Pi thinking section.
        return;
      }
      const thinkingParts: string[] = [];
      let end = contentIndex;
      while (end < message.content.length) {
        const thinkingBlock = message.content[end];
        if (thinkingBlock?.type !== "thinking") break;
        const thinking = thinkingBlock.redacted ? "[Reasoning redacted]" : thinkingBlock.thinking;
        if (thinking.trim()) thinkingParts.push(thinking.trim());
        end++;
      }
      const thinking = thinkingParts.join("\n\n");
      if (!thinking) return;
      const existing = blockIndices.get(contentIndex);
      if (existing !== undefined && runtimeTab.chat[existing]?.role === "thinking") {
        const prev = runtimeTab.chat[existing]!;
        runtimeTab.chat[existing] = {
          role: "thinking",
          text: thinking,
          // In-place replacement must carry the timer stamps.
          ...(prev.thinkingStartedAt !== undefined
            ? { thinkingStartedAt: prev.thinkingStartedAt }
            : {}),
          ...(prev.thinkingEndedAt !== undefined ? { thinkingEndedAt: prev.thinkingEndedAt } : {}),
        };
        for (let index = contentIndex; index < end; index++) blockIndices.set(index, existing);
        openThinkingIndex = existing;
        return;
      }
      const index =
        runtimeTab.chat.push({ role: "thinking", text: thinking, thinkingStartedAt: Date.now() }) -
        1;
      for (let blockIndex = contentIndex; blockIndex < end; blockIndex++) {
        blockIndices.set(blockIndex, index);
      }
      openThinkingIndex = index;
      return;
    }
    if (block.type === "toolCall") {
      stampOpenThinkingEnd(runtimeTab, openThinkingIndex);
      openThinkingIndex = undefined;
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
