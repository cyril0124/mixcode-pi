import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import { expandSkillCommand, type KnownSkill } from "./skill-command.js";

export interface BuildModelPromptOptions {
  /** Pre-resolved skills from the resource loader (includes extension-contributed skills). */
  knownSkills?: KnownSkill[];
  /** Prompt templates from the resource loader (includes extension-contributed templates). */
  promptTemplates?: PromptTemplate[];
}

/**
 * Expand `/skill:<name>` commands and `/template` prompt templates.
 * `$SkillName` references are handled by the skill-refs extension inside
 * Pi's native prompt pipeline (input/before_agent_start events), so the
 * user text passes through here verbatim.
 */
export async function buildModelPrompt(
  text: string,
  workdir: string,
  options?: BuildModelPromptOptions,
): Promise<string> {
  const skillResult = await expandSkillCommand(text, workdir, {
    knownSkills: options?.knownSkills,
  });
  let effectiveText = skillResult.text;

  // Expand prompt templates (/templateName args)
  const promptTemplates = options?.promptTemplates;
  if (promptTemplates && promptTemplates.length > 0) {
    effectiveText = expandPromptTemplate(effectiveText, promptTemplates);
  }

  return effectiveText;
}
