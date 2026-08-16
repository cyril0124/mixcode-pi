/**
 * MixCode tab titles injected into agent bash tool child env (Pi PI_* style).
 * Only the bash tool spawn path sets these — not the host process, not user `!`.
 */

export const MIXCODE_TAB_TITLE_ENV = "MIXCODE_TAB_TITLE" as const;
export const MIXCODE_FOCUSED_TAB_TITLE_ENV = "MIXCODE_FOCUSED_TAB_TITLE" as const;

export type MixCodeTabEnvTitles = {
  /** Title of the tab that owns the agent running bash (e.g. Agent-01). */
  tabTitle: string;
  /** UI-focused agent tab title; omit/empty when focus is Home or unknown. */
  focusedTabTitle?: string;
};

/**
 * Clear prior MixCode tab keys then set non-empty titles.
 * Mutates and returns `env` (same object) for spawnHook chaining.
 */
export function applyMixCodeTabEnv(
  env: Record<string, string | undefined>,
  titles: MixCodeTabEnvTitles,
): Record<string, string | undefined> {
  delete env[MIXCODE_TAB_TITLE_ENV];
  delete env[MIXCODE_FOCUSED_TAB_TITLE_ENV];
  const tabTitle = titles.tabTitle.trim();
  if (tabTitle) env[MIXCODE_TAB_TITLE_ENV] = tabTitle;
  const focused = titles.focusedTabTitle?.trim();
  if (focused) env[MIXCODE_FOCUSED_TAB_TITLE_ENV] = focused;
  return env;
}
