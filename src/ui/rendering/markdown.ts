import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
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
    highlightCode: (code: string) => code.split("\n").map((line) => activeRenderTheme.text(line)),
  };
}

function padRenderedMarkdownLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return padLine(line, width);
  return line;
}
