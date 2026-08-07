import {
  createMermaidMarkdownTransformer,
  highlightCode,
  type MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import {
  currentExtensionTheme,
  ensureExtensionThemeInitialized,
} from "../../agent/runtime-extension-theme.js";
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
  return {
    heading: (text: string) => activeRenderTheme.accent(text),
    link: (text: string) => activeRenderTheme.tool(text),
    linkUrl: (text: string) => activeRenderTheme.dim(text),
    code: (text: string) => activeRenderTheme.tool(text),
    codeBlock: (text: string) => activeRenderTheme.text(text),
    codeBlockBorder: (text: string) => activeRenderTheme.border(text),
    quote: (text: string) => activeRenderTheme.thinking(text),
    quoteBorder: (text: string) => activeRenderTheme.border(text),
    hr: (text: string) => activeRenderTheme.border(text),
    listBullet: (text: string) => activeRenderTheme.accent(text),
    bold: (text: string) => activeRenderTheme.bold(text),
    italic: (text: string) => activeRenderTheme.italic(text),
    strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
    underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
    // Reuse the SDK's syntax highlighter (highlight.js) so fenced code blocks
    // in assistant/thinking markdown get per-token colors, matching pi agent.
    // highlightCode reads the SDK global theme; ensureExtensionThemeInitialized
    // sets it to the "dark" builtin (the only brightness MixCode ships) and
    // caches that so this per-frame path skips the ~40us initTheme cost.
    // Falls back to flat color for unknown/absent languages.
    // pi-tui expects highlightCode to return string[] (one entry per line).
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
