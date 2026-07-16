import type { RuntimeTab } from "../../agent/runtime.js";
import type { OversizedAssistantMessageSettings } from "../../core/mixcode-settings.js";
import { isScrollFrozen } from "./agent-surface-scroll.js";
import { STREAMING_MARKDOWN_CHAR_LIMIT, type RenderChatBlockOptions } from "./chat.js";

export interface AgentSurfaceRenderOptions {
  oversizedAssistantMessage?: OversizedAssistantMessageSettings;
  /** When true, thinking blocks collapse to a static placeholder. */
  hideThinking?: boolean;
  /** When false, mermaid fences stay plain code blocks. Default true. */
  renderMermaid?: boolean;
}

export function chatBlockRenderOptions(
  runtimeTab: RuntimeTab | undefined,
  chatIndex: number,
  options: AgentSurfaceRenderOptions,
): RenderChatBlockOptions | undefined {
  const result: RenderChatBlockOptions = {};
  const policy = options.oversizedAssistantMessage;
  if (policy) result.oversizedAssistantMessage = policy;
  if (options.hideThinking) result.hideThinking = true;
  if (options.renderMermaid === false) result.renderMermaid = false;

  const streaming = runtimeTab?.streamingAssistant;
  const line = runtimeTab?.chat[chatIndex];
  if (
    streaming &&
    !isScrollFrozen(runtimeTab.tab) &&
    (line?.role === "assistant" || line?.role === "thinking")
  ) {
    if (streaming.chatIndex === chatIndex) {
      result.streamingMarkdownCharLimit = STREAMING_MARKDOWN_CHAR_LIMIT;
    } else {
      for (const index of streaming.blockIndices.values()) {
        if (index === chatIndex) {
          result.streamingMarkdownCharLimit = STREAMING_MARKDOWN_CHAR_LIMIT;
          break;
        }
      }
    }
  }

  return result.oversizedAssistantMessage ||
    result.streamingMarkdownCharLimit !== undefined ||
    result.hideThinking ||
    result.renderMermaid === false
    ? result
    : undefined;
}

export function oversizedPolicyKey(policy: OversizedAssistantMessageSettings | undefined): string {
  if (!policy) return "none";
  return policy.enabled ? `on:${policy.maxLines}:${policy.maxBytes}` : "off";
}
