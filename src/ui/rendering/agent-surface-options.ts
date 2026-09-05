import type { RuntimeTab } from "../../agent/runtime.js";
import type { OversizedAssistantMessageSettings } from "../../core/mixcode-settings.js";
import type { MermaidRenderingMode } from "../../core/types.js";
import { isScrollFrozen } from "./agent-surface-scroll.js";
import { STREAMING_MARKDOWN_CHAR_LIMIT, type RenderChatBlockOptions } from "./chat.js";

export interface AgentSurfaceRenderOptions {
  oversizedAssistantMessage?: OversizedAssistantMessageSettings;
  /** When true, thinking blocks collapse to a hidden form (label or placeholder). */
  hideThinking?: boolean;
  /** With hideThinking: render a 3-row tail with a left rail instead of the placeholder. */
  boxedHiddenThinking?: boolean;
  /** Pi `markdown.mermaid` mode. Default `streaming`. */
  mermaidRenderingMode?: MermaidRenderingMode;
  /** When false, hide user/tool image strips. Default true. */
  showImages?: boolean;
  /** Max image width in terminal cells. Default 60. */
  imageWidthCells?: number;
}

export function chatBlockRenderOptions(
  runtimeTab: RuntimeTab | undefined,
  chatIndex: number,
  options: AgentSurfaceRenderOptions,
): RenderChatBlockOptions | undefined {
  const result: RenderChatBlockOptions = {};
  const policy = options.oversizedAssistantMessage;
  if (policy) result.oversizedAssistantMessage = policy;
  if (options.hideThinking) {
    result.hideThinking = true;
    result.boxedHiddenThinking = options.boxedHiddenThinking === true;
  }
  if (options.mermaidRenderingMode && options.mermaidRenderingMode !== "streaming") {
    result.mermaidRenderingMode = options.mermaidRenderingMode;
  }
  if (options.showImages === false) result.showImages = false;
  if (options.imageWidthCells !== undefined) result.imageWidthCells = options.imageWidthCells;

  // Pi InteractiveMode.getMarkdownTransformers: mermaid is local; extensions via runner.
  const transformers = runtimeTab?.agentSession?.extensionRunner?.getMarkdownTransformers?.();
  if (transformers && transformers.length > 0) {
    result.markdownTransformers = transformers;
  }

  const streaming = runtimeTab?.streamingAssistant;
  const line = runtimeTab?.chat[chatIndex];
  if (
    streaming &&
    runtimeTab &&
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
    result.mermaidRenderingMode ||
    result.showImages === false ||
    result.imageWidthCells !== undefined ||
    result.markdownTransformers
    ? result
    : undefined;
}

export function oversizedPolicyKey(policy: OversizedAssistantMessageSettings | undefined): string {
  if (!policy) return "none";
  return policy.enabled ? `on:${policy.maxLines}:${policy.maxBytes}` : "off";
}
