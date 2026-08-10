import {
  createMermaidMarkdownTransformer,
  type MarkdownTransformContext,
  type MarkdownTransformer,
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
  // Pi InteractiveMode: mermaid first, then extensionRunner.getMarkdownTransformers().
  const transformers: MarkdownTransformer[] = [
    mermaidTransformer,
    ...(options.transformers ?? []),
  ];
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
        applyMarkdownTransformers(source, {
          messageType: options.messageType ?? "assistant",
          isStreaming: options.isStreaming ?? false,
          availableWidth,
        }, transformers),
    },
  );
  return markdown.render(width).map((line) => padRenderedMarkdownLine(line, width));
}

/**
 * Match Pi `applyMarkdownTransformers`: sequential apply; non-string / thrown
 * results keep the current markdown and continue.
 */
export function applyMarkdownTransformers(
  markdown: string,
  context: MarkdownTransformContext,
  transformers: readonly MarkdownTransformer[],
): string {
  let transformedMarkdown = markdown;
  for (const transformer of transformers) {
    try {
      const transformed = transformer(transformedMarkdown, context);
      if (typeof transformed === "string") {
        transformedMarkdown = transformed;
      }
    } catch {
      // Keep the current Markdown and continue with the next transformer.
    }
  }
  return transformedMarkdown;
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
