import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Image Hoist Extension
 *
 * Claude models have significantly degraded vision accuracy when images are
 * embedded inside tool_result blocks compared to top-level user message image
 * blocks. This extension intercepts Anthropic API requests and hoists images
 * from the last user message's tool_result blocks to the top level of that
 * same user message, improving image recognition accuracy.
 *
 * Only applies to anthropic-messages API requests. Other providers (OpenAI,
 * Google, etc.) handle tool_result images correctly and are not affected.
 */

interface ImageSource {
  type: "base64";
  media_type: string;
  data: string;
}

interface ImageBlock {
  type: "image";
  source: ImageSource;
  cache_control?: unknown;
}

interface TextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: (TextBlock | ImageBlock)[] | string;
  is_error?: boolean;
  cache_control?: unknown;
}

type ContentBlock = TextBlock | ImageBlock | ToolResultBlock | { type: string; [key: string]: unknown };

interface Message {
  role: string;
  content: ContentBlock[] | string;
}

interface AnthropicPayload {
  model?: string;
  messages?: Message[];
  [key: string]: unknown;
}

/**
 * Check if a payload looks like an Anthropic messages API request.
 */
function isAnthropicPayload(payload: unknown): payload is AnthropicPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return Array.isArray(p.messages) && typeof p.model === "string";
}

/**
 * Extract image blocks from a tool_result's content array.
 * Returns the extracted images and the remaining content.
 */
function extractImagesFromToolResult(
  content: (TextBlock | ImageBlock)[],
): { images: ImageBlock[]; remaining: (TextBlock | ImageBlock)[] } {
  const images: ImageBlock[] = [];
  const remaining: (TextBlock | ImageBlock)[] = [];
  for (const block of content) {
    if (block.type === "image") {
      images.push(block as ImageBlock);
    } else {
      remaining.push(block);
    }
  }
  return { images, remaining };
}

/**
 * Hoist images from tool_result blocks in the last user message to the
 * top level of that message. Mutates the payload in place.
 *
 * Returns the number of images hoisted.
 */
export function hoistImages(payload: AnthropicPayload): number {
  const messages = payload.messages;
  if (!messages) return 0;

  const userMsg = messages.findLast((message) => message.role === "user");
  if (!userMsg || !Array.isArray(userMsg.content)) return 0;

  const hoisted: ImageBlock[] = [];

  // Scan tool_result blocks for images
  for (const block of userMsg.content) {
    if (block.type !== "tool_result") continue;
    const tr = block as ToolResultBlock;
    if (!Array.isArray(tr.content)) continue;

    const { images, remaining } = extractImagesFromToolResult(tr.content as (TextBlock | ImageBlock)[]);
    if (images.length === 0) continue;

    hoisted.push(...images);

    // Replace tool_result content with remaining (text-only) blocks
    if (remaining.length === 0) {
      tr.content = [{ type: "text", text: "(image hoisted to message level)" }];
    } else {
      tr.content = remaining;
    }
  }

  if (hoisted.length === 0) return 0;

  // Insert hoisted images at the end of the user message content
  // (after all tool_result blocks, so the model sees them prominently)
  for (const img of hoisted) {
    (userMsg.content as ContentBlock[]).push(img);
  }

  return hoisted.length;
}

const extension: ExtensionFactory = (pi) => {
  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    if (!isAnthropicPayload(payload)) return;

    // Only apply to anthropic-messages API (not openai-responses, etc.)
    // The presence of tool_result blocks in user messages is the Anthropic pattern.
    const hoisted = hoistImages(payload);
    if (hoisted > 0) {
      return payload;
    }
  });
};

export default extension;
