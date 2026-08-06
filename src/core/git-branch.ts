import { FooterDataProvider } from "@earendil-works/pi-coding-agent";

/**
 * One Pi FooterDataProvider per workdir.
 * Shares watchers between chrome badge and extension footerData adapters.
 */
const providers = new Map<string, FooterDataProvider>();

function providerFor(workdir: string): FooterDataProvider | undefined {
  const key = workdir.trim();
  if (!key) return undefined;
  let provider = providers.get(key);
  if (!provider) {
    provider = new FooterDataProvider(key);
    providers.set(key, provider);
  }
  return provider;
}

/**
 * Read git branch for a workdir (Pi FooterDataProvider).
 * Returns "" when unknown / not a repo (Pi null → empty for chrome badge).
 * First call may resolve HEAD synchronously; watchers keep it fresh.
 */
export function gitBranchForWorkdir(workdir: string): string {
  return providerFor(workdir)?.getGitBranch() ?? "";
}

/**
 * Subscribe to branch value changes for a workdir (Pi FooterDataProvider.onBranchChange).
 * Returns unsubscribe.
 */
export function onGitBranchChange(workdir: string, callback: () => void): () => void {
  const provider = providerFor(workdir);
  if (!provider) return () => undefined;
  return provider.onBranchChange(callback);
}
