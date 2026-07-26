import type { SessionSelectorComponent } from "@earendil-works/pi-coding-agent";

/**
 * Host state for the session resume selector.
 * List UI is Pi's public SessionSelectorComponent; this only tracks open/lifecycle.
 */
export interface SessionSelectorState {
  open: boolean;
  /** Active session file path when the selector opened (blocks self-delete / self-resume). */
  currentSessionPath: string | null;
  /** Live Pi component while open; cleared on close. */
  component?: SessionSelectorComponent;
  /** Clear editor input slot / other host resources; set while open. */
  dispose?: () => void;
}

export function createSessionSelectorState(): SessionSelectorState {
  return {
    open: false,
    currentSessionPath: null,
  };
}
