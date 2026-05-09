import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface PackageUpdateCheckOptions {
  workdir: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function checkPiPackageUpdates(options: PackageUpdateCheckOptions): Promise<string[]> {
  if (options.env?.PI_OFFLINE ?? process.env.PI_OFFLINE) return [];
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.workdir, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd: options.workdir,
    agentDir,
    settingsManager,
  });
  const updates = await packageManager.checkForAvailableUpdates();
  return updates.map((update) => update.displayName);
}
