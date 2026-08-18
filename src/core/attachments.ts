import * as path from "node:path";
import { homeDir as resolveHomeDir } from "./paths.js";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function isProjectSkillsOnlyEnabled(env = process.env): boolean {
  const raw = env.MIXCODE_PROJECT_SKILLS_ONLY?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function resolveSkillDirs(
  baseWorkdir: string,
  homeDir = resolveHomeDir(),
  env = process.env,
): string[] {
  if (isProjectSkillsOnlyEnabled(env)) {
    return [path.resolve(path.join(baseWorkdir, ".agents", "skills"))];
  }
  const dirs = [
    path.join(baseWorkdir, ".agents", "skills"),
    path.join(homeDir, ".agents", "skills"),
    path.join(getAgentDir(), "skills"),
  ];
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

export interface SkillEntry {
  name: string;
  path: string;
  description?: string;
}

export async function scanSkillEntries(
  baseWorkdir: string,
  homeDir = resolveHomeDir(),
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
