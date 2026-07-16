import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { ensureExtensionThemeInitialized } from "../../agent/runtime-extension-theme.js";
import { activeRenderTheme } from "./context.js";
import { renderMermaidASCII } from "./mermaid.js";
import { padLine } from "./primitives.js";

let renderMarkdownObserver: ((text: string, width: number) => void) | undefined;

export function renderMarkdown(
  text: string,
  width: number,
  options: {
    color?: (text: string) => string;
    italic?: boolean;
    /** When false, mermaid fences stay plain code blocks. Default true. */
    renderMermaid?: boolean;
  } = {},
): string[] {
  renderMarkdownObserver?.(text, width);
  const markdown = new Markdown(text, 1, 0, getMarkdownTheme(width, options.renderMermaid !== false), {
    color: options.color ?? activeRenderTheme.text,
    italic: options.italic,
  });
  return markdown.render(width).map((line) => padRenderedMarkdownLine(line, width));
}

export function observeRenderMarkdownForTests(
  observer: ((text: string, width: number) => void) | undefined,
): void {
  renderMarkdownObserver = observer;
}

function getMarkdownTheme(width: number, renderMermaid: boolean): MarkdownTheme {
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
    // Mermaid fences are intercepted when renderMermaid is enabled and rendered
    // as Unicode box art using the current theme colors.
    // pi-tui expects highlightCode to return string[] (one entry per line).
    highlightCode: (code: string, lang?: string) => {
      if (renderMermaid && isMermaidLang(lang)) {
        return renderMermaidASCII(code, width, {
          border: activeRenderTheme.border,
          nodeText: activeRenderTheme.text,
          edge: activeRenderTheme.dim,
          edgeLabel: activeRenderTheme.tool,
          title: activeRenderTheme.accent,
        });
      }
      ensureExtensionThemeInitialized();
      return highlightCode(code, lang);
    },
  };
}

function isMermaidLang(lang: string | undefined): boolean {
  if (!lang) return false;
  return lang.trim().toLowerCase() === "mermaid";
}

function padRenderedMarkdownLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return padLine(line, width);
  return line;
}
