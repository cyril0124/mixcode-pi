import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { ensureExtensionThemeInitialized } from "../../agent/runtime-extension-theme.js";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

let renderMarkdownObserver: ((text: string, width: number) => void) | undefined;

export function renderMarkdown(
  text: string,
  width: number,
  options: { color?: (text: string) => string; italic?: boolean } = {},
): string[] {
  renderMarkdownObserver?.(text, width);
  const markdown = new Markdown(text, 1, 0, getMarkdownTheme(), {
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
    // highlightCode reads the SDK global theme, which mixcode standardizes to
    // "dark" (same baseline the read/write tool previews already use); ensure
    // it is initialized so the first code block isn't silently left uncolored.
    // Falls back to flat text color for unknown/absent languages.
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
