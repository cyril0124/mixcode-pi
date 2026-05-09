import { buildPrompt } from "./attachments.js";

export async function buildModelPrompt(text: string, workdir: string): Promise<string> {
  const built = await buildPrompt(text, workdir);
  return built.parts
    .map((part) => part.text)
    .filter((part) => part.trim())
    .join("\n\n");
}
