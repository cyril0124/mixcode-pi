import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveSkillFile } from "./attachments.js";

/**
 * Strip YAML frontmatter from a SKILL.md file content.
 * Returns the body after the closing `---` delimiter.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const endIndex = content.indexOf("\n---", 4);
  if (endIndex === -1) return content;
  return content.slice(endIndex + 4).trim();
}

export interface ExpandSkillCommandResult {
  expanded: boolean;
  text: string;
  skillName?: string;
}

/**
 * Expand `/skill:<name> [args]` commands into full skill content blocks.
 *
 * Follows the Pi reference implementation pattern:
 * - Parses the skill name from the `/skill:` prefix
 * - Resolves the SKILL.md file from standard skill directories
 * - Reads the file, strips frontmatter, and wraps in a `<skill>` XML block
 * - Appends any user arguments after the skill block
 *
 * Returns the original text unchanged if:
 * - The text does not start with `/skill:`
 * - The skill cannot be found
 * - The skill file cannot be read
 */
export async function expandSkillCommand(
  text: string,
  workdir: string,
): Promise<ExpandSkillCommandResult> {
  if (!text.startsWith("/skill:")) return { expanded: false, text };

  const spaceIndex = text.indexOf(" ");
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

  if (!skillName) return { expanded: false, text };

  let filePath: string;
  try {
    filePath = await resolveSkillFile(skillName, workdir);
  } catch {
    // Unknown skill — pass through unchanged
    return { expanded: false, text };
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const body = stripFrontmatter(content).trim();
    const baseDir = dirname(filePath);
    const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    const expandedText = args ? `${skillBlock}\n\n${args}` : skillBlock;
    return { expanded: true, text: expandedText, skillName };
  } catch {
    // File read error — pass through unchanged
    return { expanded: false, text };
  }
}
