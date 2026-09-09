import {
  applyMarkdownTransformers,
  createMermaidMarkdownTransformer,
  type MarkdownTransformContext,
  type MarkdownTransformer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import {
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
} from "../../agent/runtime-extension-theme.js";
import type { MermaidRenderingMode } from "../../core/types.js";
import { getMarkdownTheme as getPiMarkdownTheme, highlightCode } from "../pi-theme-api.js";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

// Pi parity (InteractiveMode.getMarkdownThemeWithSettings): settings.json
// `markdown.codeBlockIndent` controls the prefix of rendered code block lines.
// Bootstrap injects the value from Pi SettingsManager; undefined keeps the
// pi-tui default ("  ").
let codeBlockIndent: string | undefined;

export function setMarkdownCodeBlockIndent(indent: string): void {
  codeBlockIndent = indent;
}

export function renderMarkdown(
  text: string,
  width: number,
  options: {
    color?: (text: string) => string;
    italic?: boolean;
    /** Pi `markdown.mermaid` mode. Default `streaming`. */
    mermaidRenderingMode?: MermaidRenderingMode;
    /** Pi message context controls whether Mermaid is eligible for rendering. */
    messageType?: MarkdownTransformContext["messageType"];
    isStreaming?: boolean;
    /** When false, LaTeX math stays as source. Default true. */
    renderLatex?: boolean;
    /** Pi UserMessageComponent: keep source list markers (default false). */
    preserveOrderedListMarkers?: boolean;
    /** Pi UserMessageComponent: keep source backslash escapes (default false). */
    preserveBackslashEscapes?: boolean;
    /**
     * Extension markdown transformers (Pi `getMarkdownTransformers()`).
     * Applied after the built-in mermaid transformer, matching Pi order.
     */
    transformers?: readonly MarkdownTransformer[];
  } = {},
): string[] {
  const mermaidTransformer = createMermaidMarkdownTransformer({
    getMode: () => options.mermaidRenderingMode ?? "streaming",
    theme: currentExtensionTheme(),
  });
  const needsTransformers = options.transformers !== undefined || text.includes("```");
  const transformers: MarkdownTransformer[] = needsTransformers
    ? [mermaidTransformer, ...(options.transformers ?? [])]
    : [];
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
      ...(needsTransformers
        ? {
            transform: (source: string, availableWidth: number) =>
              applyMarkdownTransformers(
                source,
                {
                  messageType: options.messageType ?? "assistant",
                  isStreaming: options.isStreaming ?? false,
                  availableWidth,
                },
                transformers,
              ),
          }
        : {}),
    },
  );
  return markdown.render(width).map((line) => padRenderedMarkdownLine(line, width));
}

export function getMarkdownTheme(): MarkdownTheme {
  // Sync global Pi theme once, then use Pi md* tokens so third-party themes apply.
  ensureExtensionThemeInitialized();
  const pi = getPiMarkdownTheme();
  return {
    ...pi,
    ...(codeBlockIndent !== undefined ? { codeBlockIndent } : {}),
    // Keep highlight on the same initialized global Theme instance.
    highlightCode: (code: string, lang?: string) => {
      ensureExtensionThemeInitialized();
      return highlightCode(code, lang);
    },
  };
}

// Pi's collapsible cards accept a MarkdownTheme, but no transform callback.
// Preserve the existing card diagram behavior before handing their body to Pi.
export function transformMessageCardMarkdown(text: string, width: number, theme: Theme): string {
  if (!text.includes("```")) return text;
  const transform = createMermaidMarkdownTransformer({ getMode: () => "streaming", theme });
  return transform(text, {
    messageType: "assistant",
    isStreaming: false,
    availableWidth: Math.max(1, width - 2),
  });
}

function padRenderedMarkdownLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return padLine(line, width);
  return line;
}
