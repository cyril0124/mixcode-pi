import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, TUI as PiTui } from "@earendil-works/pi-tui";
import {
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
} from "./runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "./runtime-pi-tui-bridge.js";
import { NullTerminal } from "./runtime-null-terminal.js";
import { contentText } from "./runtime-text.js";
import type { ChatLine, RuntimeTab, ToolResultLike } from "./runtime-types.js";

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
  const toolName = options.toolName || "unknown";
  const definition = runtimeTab.agentSession.getToolDefinition(toolName);
  const rendererState = options.previous?.toolRendererState ?? {};
  const line: ChatLine = {
    role: "tool",
    title: toolName,
    status: options.status,
    toolCallId: options.toolCallId,
    text: options.text,
    args: options.args,
    toolResult: options.result,
    toolIsPartial: options.isPartial,
    toolRenderShell: definition?.renderShell ?? "default",
    toolRendererState: rendererState,
    toolCallRendererLastComponent: options.previous?.toolCallRendererLastComponent,
    toolResultRendererLastComponent: options.previous?.toolResultRendererLastComponent,
  };
  if (definition?.renderCall) {
    line.renderToolCall = (width) => renderToolCall(runtimeTab, line, definition, width);
  }
  if (options.result && definition?.renderResult) {
    line.renderToolResult = (width) =>
      renderToolResult(runtimeTab, line, definition, options.result!, options.isPartial, width);
  }
  return line;
}

function renderToolCall(
  runtimeTab: RuntimeTab,
  line: ChatLine,
  definition: ToolDefinition,
  width: number,
): string[] {
  ensureExtensionThemeInitialized();
  const terminal = new NullTerminal(Math.max(1, Math.floor(width)));
  const tui = new PiTui(terminal);
  const previousComponent = line.toolCallRendererLastComponent as
    | (Component & { dispose?(): void })
    | undefined;
  // Apply mixcode keybindings on every pi-tui copy (top-level + nested) so
  // upstream renderers resolve keyText against the same manager we do.
  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    const component = definition.renderCall?.(
      line.args as never,
      currentExtensionTheme(),
      createToolRenderContext(
        runtimeTab,
        line,
        previousComponent,
        line.toolIsPartial ?? line.status === "running",
      ),
    ) as (Component & { dispose?(): void }) | undefined;
    if (previousComponent && previousComponent !== component) previousComponent.dispose?.();
    line.toolCallRendererLastComponent = component;
    if (!component) return [];
    return component.render(terminal.columns);
  } catch (error) {
    previousComponent?.dispose?.();
    line.toolCallRendererLastComponent = undefined;
    const detail = error instanceof Error ? error.message : String(error);
    return [`tool call renderer error (${line.title ?? "tool"}): ${detail}`];
  } finally {
    restoreKeybindings();
    tui.stop();
  }
}

function renderToolResult(
  runtimeTab: RuntimeTab,
  line: ChatLine,
  definition: ToolDefinition,
  result: ToolResultLike,
  isPartial: boolean,
  width: number,
): string[] {
  ensureExtensionThemeInitialized();
  const terminal = new NullTerminal(Math.max(1, Math.floor(width)));
  const tui = new PiTui(terminal);
  const previousComponent = line.toolResultRendererLastComponent as
    | (Component & { dispose?(): void })
    | undefined;
  const restoreKeybindings = applyMixCodeKeybindings();
  try {
    const component = definition.renderResult?.(
      { content: result.content, details: result.details } as AgentToolResult<unknown>,
      { expanded: runtimeTab.tab.extensionUi.toolsExpanded, isPartial },
      currentExtensionTheme(),
      createToolRenderContext(runtimeTab, line, previousComponent, isPartial, result.isError),
    ) as (Component & { dispose?(): void }) | undefined;
    if (previousComponent && previousComponent !== component) previousComponent.dispose?.();
    line.toolResultRendererLastComponent = component;
    if (!component) return [];
    return component.render(terminal.columns);
  } catch (error) {
    previousComponent?.dispose?.();
    line.toolResultRendererLastComponent = undefined;
    const detail = error instanceof Error ? error.message : String(error);
    return [`tool renderer error (${line.title ?? "tool"}): ${detail}`];
  } finally {
    restoreKeybindings();
    tui.stop();
  }
}

function createToolRenderContext(
  runtimeTab: RuntimeTab,
  line: ChatLine,
  lastComponent: Component | undefined,
  isPartial: boolean,
  isError = false,
) {
  return {
    args: line.args,
    toolCallId: line.toolCallId ?? "",
    invalidate: () => runtimeTab.requestRender?.(),
    lastComponent,
    state: line.toolRendererState ?? {},
    cwd: runtimeTab.tab.workdir,
    executionStarted: line.status !== "pending",
    argsComplete: line.status !== "pending" && line.status !== "running",
    isPartial,
    expanded: runtimeTab.tab.extensionUi.toolsExpanded,
    showImages: true,
    isError,
  };
}

export function summarizeToolResult(result: unknown, isError: boolean): string {
  if (isAgentToolResult(result)) {
    return summarizeToolContent(result.content, isError);
  }
  return summarizeUnknown(result);
}

export function normalizeToolResult(result: unknown, isError: boolean): ToolResultLike | undefined {
  if (!isAgentToolResult(result)) return undefined;
  return {
    content: result.content,
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

export function formatToolPreview(
  toolName: string,
  content: string | Array<{ type: string; text?: string }>,
  isError: boolean,
): string {
  const status = isError ? "error" : "ok";
  return [`tool ${toolName}: ${status}`, "", contentText(content)].join("\n");
}

export function summarizeUnknown(value: unknown): string {
  if (typeof value === "string") return compactMultiline(value, 4, 480);
  if (isAgentToolResult(value)) return summarizeToolContent(value.content, Boolean(value.isError));
  return compactMultiline(compactJson(value), 4, 480);
}

function isAgentToolResult(
  value: unknown,
): value is { content: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean } {
  return value !== null && typeof value === "object" && "content" in value;
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
