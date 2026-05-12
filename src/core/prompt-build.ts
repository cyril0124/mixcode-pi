import { buildPrompt, SKILL_INJECTION_SEPARATOR } from "./attachments.js";

export async function buildModelPrompt(text: string, workdir: string): Promise<string> {
  const built = await buildPrompt(text, workdir);
  if (built.parts.length <= 1) {
    return built.parts[0]?.text ?? "";
  }
  // Use the skill injection separator between user text and skill content
  // so that history restoration can strip the injected portion.
  const userText = built.parts[0]!.text;
  const injectedParts = built.parts
    .slice(1)
    .map((part) => part.text)
    .filter((part) => part.trim())
    .join("\n\n");
  return `${userText}${SKILL_INJECTION_SEPARATOR}${injectedParts}`;
}
