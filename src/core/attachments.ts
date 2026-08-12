import * as os from "node:os";
import * as path from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function uniqueInOrder(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function resolveSkillDirs(baseWorkdir: string, homeDir = (process.env.HOME || os.homedir())): string[] {
  const dirs = [
    path.join(baseWorkdir, ".agents", "skills"),
    path.join(homeDir, ".agents", "skills"),
    path.join(getAgentDir(), "skills"),
  ];
  return uniqueInOrder(dirs.map((dir) => path.resolve(dir)));
}

export interface SkillEntry {
  name: string;
  path: string;
  description?: string;
}

export async function scanSkillEntries(
  baseWorkdir: string,
  homeDir = (process.env.HOME || os.homedir()),
): Promise<SkillEntry[]> {
  // Delegate discovery, validation, collision handling and ignore-file support
  // to pi's public skill loader. skillPaths preserve MixCode's scan order
  // (project-local .agents first, then user .agents, then the pi agent dir),
  // and includeDefaults:false keeps that precedence instead of pi's defaults
  // (agentDir/skills + .pi/skills) winning same-name collisions.
  const { skills } = loadSkills({
    cwd: baseWorkdir,
    agentDir: getAgentDir(),
    skillPaths: resolveSkillDirs(baseWorkdir, homeDir),
    includeDefaults: false,
  });
  return skills
    .map((skill) => ({ name: skill.name, path: skill.filePath, description: skill.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
