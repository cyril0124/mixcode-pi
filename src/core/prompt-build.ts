import { buildPrompt, SKILL_INJECTION_SEPARATOR } from "./attachments.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import { expandSkillCommand, type KnownSkill } from "./skill-command.js";

export interface BuildModelPromptOptions {
  /** Pre-resolved skills from the resource loader (includes extension-contributed skills). */
  knownSkills?: KnownSkill[];
  /** Prompt templates from the resource loader (includes extension-contributed templates). */
  promptTemplates?: PromptTemplate[];
}

export async function buildModelPrompt(
  text: string,
  workdir: string,
  options?: BuildModelPromptOptions,
): Promise<string> {
  const knownSkills = options?.knownSkills;
  const promptTemplates = options?.promptTemplates;

  // Expansion order matches Pi reference: /skill: → /template → $skill processing
  const skillResult = await expandSkillCommand(text, workdir, { knownSkills });
  let effectiveText = skillResult.text;

  // Expand prompt templates (/templateName args)
  if (promptTemplates && promptTemplates.length > 0) {
    effectiveText = expandPromptTemplate(effectiveText, promptTemplates);
  }

  const built = await buildPrompt(effectiveText, workdir, undefined, knownSkills);
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
