import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI as PiTui } from "@earendil-works/pi-tui";
import { ensureExtensionThemeInitialized } from "./runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "./runtime-pi-tui-bridge.js";
import type { ChatLine, RuntimeTab, ToolResultLike } from "./runtime-types.js";

export function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.text !== undefined ? block.text : `[${block.type}]`))
    .join("\n");
}

/**
 * Pi interactive-mode getUserMessageText: only text blocks, images omitted from the body.
 * Image blocks are carried separately via contentImages() for TUI rendering.
 */
export function userMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

export function contentImages(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): ImageContent[] {
  if (typeof content === "string") return [];
  const images: ImageContent[] = [];
  for (const block of content) {
    if (block.type !== "image") continue;
    if (typeof block.data !== "string" || typeof block.mimeType !== "string") continue;
    images.push({ type: "image", data: block.data, mimeType: block.mimeType });
  }
  return images;
}

function toolShowImages(runtimeTab: RuntimeTab): boolean {
  return runtimeTab.agentSession.settingsManager.getShowImages();
}

function toolImageWidthCells(runtimeTab: RuntimeTab): number {
  return runtimeTab.agentSession.settingsManager.getImageWidthCells();
}

export function toolExecutionToChatLine(
  runtimeTab: RuntimeTab,
  options: {
    toolCallId: string;
    toolName: string;
    status: ChatLine["status"];
    text: string;
    args?: unknown;
    result?: ToolResultLike;
    isPartial: boolean;
    previous?: ChatLine;
  },
): ChatLine {
  ensureExtensionThemeInitialized();
  const toolName = options.toolName || "unknown";
  const definition = runtimeTab.agentSession.getToolDefinition(toolName);
  const previousComponent = options.previous?.toolExecutionComponent;
  const ui = {
    requestRender: () => runtimeTab.requestRender?.(),
  } as unknown as PiTui;
  const component =
    previousComponent ??
    new ToolExecutionComponent(
      toolName,
      options.toolCallId,
      options.args,
      {
        showImages: toolShowImages(runtimeTab),
        imageWidthCells: toolImageWidthCells(runtimeTab),
      },
      definition,
      ui,
      runtimeTab.tab.workdir,
    );

  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    component.updateArgs(options.args);
    const isStarted = options.status !== "pending";
    if (isStarted) component.markExecutionStarted();
    const isComplete = options.status !== "pending" && options.status !== "running";
    if (isComplete) component.setArgsComplete();
    if (options.result) {
      component.updateResult(
        {
          content: options.result.content,
          details: options.result.details,
          isError: options.result.isError,
        },
        options.isPartial,
      );
    }
    component.setExpanded(runtimeTab.tab.extensionUi.toolsExpanded);
    component.setShowImages(toolShowImages(runtimeTab));
    component.setImageWidthCells(toolImageWidthCells(runtimeTab));
  } finally {
    restoreKeybindings();
  }

  const line: ChatLine = {
    role: "tool",
    title: toolName,
    status: options.status,
    toolCallId: options.toolCallId,
    text: options.text,
    args: options.args,
    toolResult: options.result,
    toolIsPartial: options.isPartial,
    // ToolExecutionComponent owns its own default/self shell and image strip.
    toolRenderShell: "self",
    toolExecutionComponent: component,
  };
  line.renderToolCall = (width) => {
    const restore = applyMixCodeKeybindings();
    try {
      // Ctrl+O and image settings can change after the final tool event. Keep
      // the persistent Pi component synchronized on every outer TUI render.
      component.setExpanded(runtimeTab.tab.extensionUi.toolsExpanded);
      component.setShowImages(toolShowImages(runtimeTab));
      component.setImageWidthCells(toolImageWidthCells(runtimeTab));
      return component.render(Math.max(1, Math.floor(width)));
    } finally {
      restore();
    }
  };
  return line;
}

export function summarizeToolResult(result: unknown, isError: boolean): string {
  if (isAgentToolResult(result)) {
    return summarizeToolContent(result.content, isError);
  }
  return summarizeUnknown(result);
}

export function normalizeToolResult(result: unknown, isError: boolean): ToolResultLike | undefined {
  if (!isAgentToolResult(result)) return undefined;
  // Tool result messages may contain plain text, while Pi's renderer requires content blocks.
  return {
    content:
      typeof result.content === "string"
        ? [{ type: "text", text: result.content }]
        : result.content,
    details: "details" in result ? result.details : undefined,
    isError,
  };
}

export function summarizeToolContent(
  content: string | Array<{ type: string; text?: string }>,
  isError: boolean,
): string {
  const text = contentText(content);
  const lead = isError ? "error" : "ok";
  if (!text.trim()) return lead;
  return `${lead} ${compactMultiline(text, 6, 640)}`;
}

export function summarizeUnknown(value: unknown): string {
  if (typeof value === "string") return compactMultiline(value, 4, 480);
  if (isAgentToolResult(value)) return summarizeToolContent(value.content, Boolean(value.isError));
  return compactMultiline(compactJson(value), 4, 480);
}

function isAgentToolResult(value: unknown): value is {
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "content" in value &&
    (typeof value.content === "string" || Array.isArray(value.content))
  );
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactMultiline(text: string, maxLines: number, maxChars: number): string {
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, maxLines);
  let compacted = head.join("\n");
  const hiddenLines = Math.max(0, lines.length - head.length);
  if (compacted.length > maxChars) {
    compacted = `${compacted.slice(0, Math.max(0, maxChars - 14)).trimEnd()}...`;
  }
  const hiddenChars = Math.max(0, text.length - compacted.length);
  if (hiddenLines > 0 || hiddenChars > 0) {
    const parts = [];
    if (hiddenLines > 0) parts.push(`${hiddenLines} lines`);
    if (hiddenChars > 0) parts.push(`${hiddenChars} chars`);
    compacted = `${compacted}\n[truncated ${parts.join(", ")}]`;
  }
  return compacted;
}
