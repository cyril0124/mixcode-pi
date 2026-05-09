export function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.text !== undefined ? block.text : `[${block.type}]`))
    .join("\n");
}
