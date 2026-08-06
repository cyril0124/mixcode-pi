import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Marked, Markdown, type MarkdownTheme, type Token, visibleWidth } from "@earendil-works/pi-tui";
import { render, type MermaidArt, type Span } from "grok-mermaid";
import { ensureExtensionThemeInitialized } from "../../agent/runtime-extension-theme.js";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

const mermaidParser = new Marked();

export function renderMarkdown(
  text: string,
  width: number,
  options: {
    color?: (text: string) => string;
    italic?: boolean;
    /** When false, mermaid fences stay plain code blocks. Default true. */
    renderMermaid?: boolean;
    /** When false, LaTeX math stays as source. Default true. */
    renderLatex?: boolean;
  } = {},
): string[] {
  const renderMermaid = options.renderMermaid !== false;
  const markdown = new Markdown(text, 1, 0, getMarkdownTheme(), {
    color: options.color ?? activeRenderTheme.text,
    italic: options.italic,
  }, {
    renderLatex: options.renderLatex !== false,
    transform: renderMermaid
      ? (source, availableWidth) => transformMermaidFences(source, availableWidth)
      : undefined,
  });
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

/**
 * Pi 0.84 path: replace top-level ```mermaid fences with themed Unicode art via
 * grok-mermaid before Markdown parses (same approach as coding-agent's
 * createMermaidMarkdownTransformer; that helper is not a public export).
 */
function transformMermaidFences(markdown: string, availableWidth: number): string {
  return mermaidParser
    .lexer(markdown)
    .map((token) => {
      if (!isMermaidFence(token)) return token.raw;
      const art = render(token.text);
      if (!art || art.width > availableWidth) return token.raw;
      return `${themedMermaidLines(art).map(codeSpan).join("  \n")}\n`;
    })
    .join("");
}

function isMermaidFence(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
  return (
    token.type === "code" &&
    token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid"
  );
}

function themedMermaidLines(art: MermaidArt): string[] {
  return art.styled.map((row) => row.map(styleSpan).join(""));
}

function styleSpan(span: Span): string {
  switch (span.cls) {
    case "border":
      return activeRenderTheme.border(span.text);
    case "text":
      return activeRenderTheme.text(span.text);
    case "edge":
      return activeRenderTheme.dim(span.text);
    case "edgeLabel":
      return activeRenderTheme.tool(span.text);
    case "title":
      return activeRenderTheme.accent(span.text);
    case "none":
      return span.text;
  }
}

/** Encode one diagram row as an inline code span so Markdown keeps spacing. */
function codeSpan(line: string): string {
  const content = line || "\u00a0";
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

function padRenderedMarkdownLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return padLine(line, width);
  return line;
}
