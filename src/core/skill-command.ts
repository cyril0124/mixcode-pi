import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveSkillFile } from "./attachments.js";

/**
 * A pre-resolved skill entry from the resource loader.
 * Used to find extension-contributed skills that aren't on the filesystem
 * in the standard skill directories.
 */
export interface KnownSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

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

export interface ExpandSkillCommandOptions {
  /** Pre-resolved skills from the resource loader (includes extension-contributed skills). */
  knownSkills?: KnownSkill[];
}

/**
 * Expand `/skill:<name> [args]` commands into full skill content blocks.
 *
 * Follows the Pi reference implementation pattern:
 * - Parses the skill name from the `/skill:` prefix
 * - Resolves the SKILL.md file: first from knownSkills (resource loader), then filesystem
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
  options?: ExpandSkillCommandOptions,
): Promise<ExpandSkillCommandResult> {
  if (!text.startsWith("/skill:")) return { expanded: false, text };

  const spaceIndex = text.indexOf(" ");
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

  if (!skillName) return { expanded: false, text };

  // Try resource loader skills first (includes extension-contributed skills)
  const known = options?.knownSkills?.find((s) => s.name === skillName);
  let filePath: string;
  let baseDir: string;

  if (known) {
    filePath = known.filePath;
    baseDir = known.baseDir;
  } else {
    try {
      filePath = await resolveSkillFile(skillName, workdir);
      baseDir = dirname(filePath);
    } catch {
      return { expanded: false, text };
    }
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const body = stripFrontmatter(content).trim();
    const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    const expandedText = args ? `${skillBlock}\n\n${args}` : skillBlock;
    return { expanded: true, text: expandedText, skillName };
  } catch {
    return { expanded: false, text };
  }
}
