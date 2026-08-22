/**
 * MixCode env visible to agent bash tool children (Pi PI_* style).
 *
 * MIXCODE_PID is host-process env (set once at startup in cli/main.ts) so every
 * child inherits it. The per-tab titles are applied per spawn by the
 * MIXCODE_SPAWN_ENV_BRACKET patch hunk (patches/@earendil-works%2Fpi-coding-agent@*.patch)
 * around the winning "bash" tool's execute — MixCode's own tool, or an
 * extension override that displaced it. Neither reaches user `!` shells.
 */

/** PID of the mpi host process that owns this agent; `mpi ctl` treats it as an implicit `--pid`. */
export const MIXCODE_PID_ENV = "MIXCODE_PID" as const;

export const MIXCODE_TAB_TITLE_ENV = "MIXCODE_TAB_TITLE" as const;
export const MIXCODE_FOCUSED_TAB_TITLE_ENV = "MIXCODE_FOCUSED_TAB_TITLE" as const;

export type MixCodeTabEnvTitles = {
  /** Title of the tab that owns the agent running bash (e.g. Agent-01). */
  tabTitle: string;
  /** UI-focused agent tab title; omit/empty when focus is Home or unknown. */
  focusedTabTitle?: string;
};

/**
 * Per-spawn env contribution consumed by the spawn-env bracket: a value of
 * `undefined` means "ensure the key is unset while the bracket is active", so
 * stale titles from the host env never leak into the child.
 */
export function mixCodeSpawnEnvContribution(
  titles: MixCodeTabEnvTitles,
): Record<string, string | undefined> {
  return {
    [MIXCODE_TAB_TITLE_ENV]: titles.tabTitle.trim() || undefined,
    [MIXCODE_FOCUSED_TAB_TITLE_ENV]: titles.focusedTabTitle?.trim() || undefined,
  };
}
