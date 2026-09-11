import { FooterDataProvider } from "@earendil-works/pi-coding-agent";

/**
 * One Pi FooterDataProvider per workdir.
 * Shares watchers between chrome badge and extension footerData adapters.
 */
type ProviderEntry = {
  provider: FooterDataProvider;
  subscribers: number;
};

const MAX_PROVIDER_ENTRIES = 128;
const providers = new Map<string, ProviderEntry>();

function providerFor(workdir: string): ProviderEntry | undefined {
  const key = workdir.trim();
  if (!key) return undefined;
  let entry = providers.get(key);
  if (!entry) {
    entry = { provider: new FooterDataProvider(key), subscribers: 0 };
    providers.set(key, entry);
    while (providers.size > MAX_PROVIDER_ENTRIES) {
      const oldestKey = providers.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = providers.get(oldestKey);
      if (oldest?.subscribers === 0) {
        oldest.provider.dispose();
        providers.delete(oldestKey);
      } else {
        break;
      }
    }
  }
  return entry;
}

/**
 * Read git branch for a workdir (Pi FooterDataProvider).
 * Returns "" when unknown / not a repo (Pi null → empty for chrome badge).
 * First call may resolve HEAD synchronously; watchers keep it fresh.
 */
export function gitBranchForWorkdir(workdir: string): string {
  return providerFor(workdir)?.provider.getGitBranch() ?? "";
}

/**
 * Subscribe to branch value changes for a workdir (Pi FooterDataProvider.onBranchChange).
 * Returns unsubscribe.
 */
export function onGitBranchChange(workdir: string, callback: () => void): () => void {
  const entry = providerFor(workdir);
  if (!entry) return () => undefined;
  entry.subscribers += 1;
  entry.provider.getGitBranch();
  const unsubscribeProvider = entry.provider.onBranchChange(callback);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsubscribeProvider();
    entry.subscribers -= 1;
    if (entry.subscribers === 0 && providers.get(workdir.trim()) === entry) {
      entry.provider.dispose();
      providers.delete(workdir.trim());
    }
  };
}
