import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  appendEmptyRunNotice,
  appendPreviewMessage,
  appendSystemMessage,
  assistantDisplayText,
  contextTokensFromUsage,
  customEntryToChatLine,
  customMessageToChatLine,
  disposeChatRenderers,
  entriesToChatLines,
  isBenignCompactionError,
  isNothingToCompactError,
  surfaceAssistantStopReason,
  syncContextUsage,
  syncPreviewFromChat,
  updatePreviewMessage,
} from "./runtime-chat.js";
import { contentText } from "./runtime-text.js";
import {
  addTabTokens,
  clearPendingEscape,
  setTabContextTokens,
  setPendingMessages,
  setTabStatus,
} from "../core/tab-state.js";
import {
  formatToolPreview,
  normalizeToolResult,
  summarizeToolContent,
  summarizeToolResult,
  summarizeUnknown,
  toolExecutionToChatLine,
} from "./runtime-tool-chat.js";
import { clearChatScrollAnchor } from "../core/overlays.js";
import type { ChatLine, RuntimeEvent, RuntimeTab, ToolResultLike } from "./runtime-types.js";

type AgentSessionContinuationInternals = {
  _isAgentRunActive?: boolean;
  _handlePostAgentRun?: () => Promise<boolean>;
  _emitAgentSettled?: () => Promise<void>;
};

/**
 * Atomically enter the context-limit auto-compaction cycle. These four flags
 * form one transition: a stale `autoCompactCycleFailed` from a previous cycle
 * would make the new cycle skip its compaction attempt (see the guards at the
 * top of autoCompactAndContinue), so resetting it here is load-bearing — not
 * incidental. Concentrating the set in one place removes that footgun.
 */
export function enterAutoCompactCycle(runtimeTab: RuntimeTab): void {
  runtimeTab.pendingContextLimitCompaction = false;
  runtimeTab.deferPendingMessageFlush = true;
  runtimeTab.autoCompactCycleActive = true;
  runtimeTab.autoCompactCycleFailed = false;
}

/** Leave the auto-compaction cycle, clearing the in-flight markers. */
export function endAutoCompactCycle(runtimeTab: RuntimeTab): void {
  runtimeTab.isAutoCompacting = false;
  runtimeTab.autoCompactCycleActive = false;
}

/**
 * Auto-compact the session after the current agent run becomes idle,
 * then continue the agent from the compacted transcript.
 */
async function autoCompactAndContinue(runtimeTab: RuntimeTab): Promise<void> {
  try {
    await waitForPromptPostRun(runtimeTab.agentSession);
    runtimeTab.isAutoCompacting = true;

    let compacted = isLatestBranchEntryCompaction(runtimeTab);
    if (!compacted && !runtimeTab.autoCompactCycleFailed) {
      if (runtimeTab.agentSession.isCompacting) {
        await waitForCompactionEnd(runtimeTab.agentSession);
        compacted = isLatestBranchEntryCompaction(runtimeTab);
      }
    }

    if (!compacted && !runtimeTab.autoCompactCycleFailed) {
      try {
        await runtimeTab.agentSession.compact();
        compacted = isLatestBranchEntryCompaction(runtimeTab);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted =
          message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
        if (aborted) {
          // Aborted compaction: drop the timer silently, no worked-duration recorded.
          setTabStatus(runtimeTab.tab, "idle", { discardTimer: true });
          return;
        }

        // Use unified benign error check
        if (isBenignCompactionError(error)) {
          // The mid-turn hook already terminated the tool loop. Even when
          // there is nothing useful to compact, the agent must resume from
          // the tool result instead of silently ending the user's request.
          if (isNothingToCompactError(message)) {
            appendSystemMessage(runtimeTab, "Nothing to compact (session too small).");
          }
          await continueAgentSession(runtimeTab.agentSession);
          return;
        }

        // Real error - throw to outer catch
        throw error;
      }
    }

    if (!compacted) {
      throw new Error("Auto-compaction did not produce a compaction entry");
    }
    await continueAgentSession(runtimeTab.agentSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Failed compaction: drop the timer silently, no worked-duration recorded.
    setTabStatus(runtimeTab.tab, "idle", { discardTimer: true });
    appendSystemMessage(runtimeTab, normalizeCompactionFailureMessage(message), "error");
    runtimeTab.requestRender?.();
  } finally {
    endAutoCompactCycle(runtimeTab);
  }
}

function normalizeCompactionFailureMessage(message: string): string {
  return /^(Auto-)?Compaction failed:/i.test(message) ? message : `Compaction failed: ${message}`;
}

async function waitForPromptPostRun(agentSession: RuntimeTab["agentSession"]): Promise<void> {
  await agentSession.waitForIdle();
  if (agentSession.isCompacting) await waitForCompactionEnd(agentSession);
}

function isLatestBranchEntryCompaction(runtimeTab: RuntimeTab): boolean {
  return runtimeTab.session.getBranch().at(-1)?.type === "compaction";
}

async function waitForCompactionEnd(agentSession: RuntimeTab["agentSession"]): Promise<void> {
  if (!agentSession.isCompacting) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = agentSession.subscribe((event) => {
      if (event.type !== "compaction_end") return;
      unsubscribe();
      resolve();
    });
  });
}

async function continueAgentSession(agentSession: RuntimeTab["agentSession"]): Promise<void> {
  const session = agentSession as unknown as AgentSessionContinuationInternals;
  const handlePostAgentRun = session._handlePostAgentRun;
  const emitAgentSettled = session._emitAgentSettled;
  if (
    !("_isAgentRunActive" in session) ||
    typeof handlePostAgentRun !== "function" ||
    typeof emitAgentSettled !== "function"
  ) {
    throw new Error(
      "Pi AgentSession continuation internals changed; cannot continue after auto-compaction.",
    );
  }

  // Pi has no public session-level continuation API. Mirror its prompt lifecycle
  // so guards and waitForIdle() cover this low-level continuation too.
  session._isAgentRunActive = true;
  try {
    await agentSession.agent.continue();
    while (await handlePostAgentRun.call(agentSession)) {
      await agentSession.agent.continue();
    }
  } finally {
    await emitAgentSettled.call(agentSession);
  }
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
    syncQueueState(runtimeTab, event.steering);
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
      // preserve it (??=): the mid-turn auto-compact cycle, an auto-retry
      // continuation (retryInfo still armed), and the SDK compact-and-retry
      // continue (willRetry marker).
      setTabStatus(runtimeTab.tab, "running", {
        restart:
          !runtimeTab.autoCompactCycleActive &&
          !runtimeTab.tab.retryInfo &&
          !sdkContinuation,
      });
      clearPendingEscape(runtimeTab.tab);
      break;
    }
    case "turn_start":
      runtimeTab.currentRunChatStartIndex ??= runtimeTab.chat.length;
      setTabStatus(runtimeTab.tab, "thinking");
      break;
    case "agent_end":
      // If the agent was terminated by the mid-turn hook due to compaction pressure,
      // trigger auto-compaction and continue the agent run.
      if (runtimeTab.pendingContextLimitCompaction) {
        enterAutoCompactCycle(runtimeTab);
        // Don't set idle — keep running status for the compact + continue cycle
        void autoCompactAndContinue(runtimeTab);
        break;
      }
      appendEmptyRunNotice(runtimeTab);
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
    case "compaction_start":
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
      // Two continuation shapes keep the timer running: MixCode's own mid-turn
      // cycle (autoCompactCycleActive) and the SDK's compact-and-retry
      // (willRetry: the SDK calls agent.continue() right after this event).
      const sdkWillContinue = Boolean(event.result && event.willRetry);
      if (sdkWillContinue) runtimeTab.sdkRunContinuation = true;
      const continuingAfterAutoCompaction = Boolean(
        event.result && (runtimeTab.autoCompactCycleActive || sdkWillContinue),
      );
      const nextStatus: typeof runtimeTab.tab.status = event.errorMessage
        ? runtimeTab.autoCompactCycleActive
          ? "idle"
          : "error"
        : continuingAfterAutoCompaction
          ? "running"
          : "idle";
      // Continuation keeps the timer running; a real end closes it into a duration.
      setTabStatus(runtimeTab.tab, nextStatus, {
        preserveStartedAt: continuingAfterAutoCompaction,
      });
      clearPendingEscape(runtimeTab.tab);
      if (event.result) {
        // Rebuild chat from session entries (which now include the compaction entry)
        disposeChatRenderers(runtimeTab.chat);
        runtimeTab.chat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
        syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
        syncContextUsage(runtimeTab);
        if (!continuingAfterAutoCompaction) {
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
      if (!event.result && runtimeTab.autoCompactCycleActive) {
        runtimeTab.autoCompactCycleFailed = true;
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
  }
  emitChange(event, runtimeTab);
}

export function syncQueueState(runtimeTab: RuntimeTab, steering: readonly string[]): void {
  const preserved = runtimeTab.tab.pendingMessages.slice(
    0,
    Math.max(0, runtimeTab.tab.pendingMessages.length - runtimeTab.queuedPromptCount),
  );
  setPendingMessages(runtimeTab.tab, [...preserved, ...steering]);
  runtimeTab.queuedPromptCount = steering.length;
}

export function appendMessageStart(runtimeTab: RuntimeTab, message: AgentMessage): void {
  if (message.role === "user") {
    const text = contentText(message.content);
    if (!text.trim()) return;
    clearChatScrollAnchor(runtimeTab.tab);
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
