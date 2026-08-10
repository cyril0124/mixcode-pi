import {
  createMermaidMarkdownTransformer,
  type MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import {
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
} from "../../agent/runtime-extension-theme.js";
import { getMarkdownTheme as getPiMarkdownTheme, highlightCode } from "../pi-theme-api.js";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

export function renderMarkdown(
  text: string,
  width: number,
  options: {
    color?: (text: string) => string;
    italic?: boolean;
    /** When false, mermaid fences stay plain code blocks. Default true. */
    renderMermaid?: boolean;
    /** Pi message context controls whether Mermaid is eligible for rendering. */
    messageType?: MarkdownTransformContext["messageType"];
    isStreaming?: boolean;
    /** When false, LaTeX math stays as source. Default true. */
    renderLatex?: boolean;
    /** Pi UserMessageComponent: keep source list markers (default false). */
    preserveOrderedListMarkers?: boolean;
    /** Pi UserMessageComponent: keep source backslash escapes (default false). */
    preserveBackslashEscapes?: boolean;
  } = {},
): string[] {
  const mermaidTransformer = createMermaidMarkdownTransformer({
    getMode: () => (options.renderMermaid === false ? "off" : "streaming"),
    theme: currentExtensionTheme(),
  });
  const markdown = new Markdown(
    text,
    1,
    0,
    getMarkdownTheme(),
    {
      color: options.color ?? activeRenderTheme.text,
      italic: options.italic,
    },
    {
      renderLatex: options.renderLatex !== false,
      preserveOrderedListMarkers: options.preserveOrderedListMarkers,
      preserveBackslashEscapes: options.preserveBackslashEscapes,
      transform: (source, availableWidth) =>
        mermaidTransformer(source, {
          messageType: options.messageType ?? "assistant",
          isStreaming: options.isStreaming ?? false,
          availableWidth,
        }),
    },
  );
  return markdown.render(width).map((line) => padRenderedMarkdownLine(line, width));
}

function getMarkdownTheme(): MarkdownTheme {
  // Sync global Pi theme once, then use Pi md* tokens so third-party themes apply.
  ensureExtensionThemeInitialized();
  const pi = getPiMarkdownTheme();
  return {
    ...pi,
    // Keep highlight on the same initialized global Theme instance.
    highlightCode: (code: string, lang?: string) => {
      ensureExtensionThemeInitialized();
      return highlightCode(code, lang);
    },
  };
}

function padRenderedMarkdownLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return padLine(line, width);
  return line;
}
