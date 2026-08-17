import type { MixCodeTabInfo } from "./types.js";

export const PENDING_ESCAPE_CONFIRM_WINDOW_MS = 1_000;

export function clearPendingEscape(tab: MixCodeTabInfo): void {
  tab.pendingEscapeArmedAt = undefined;
  // Callers use this on non-Esc keys to cancel confirm arms; also cancel the
  // empty-editor double-Esc tree/fork arm (lastEscapeTime) so a later Esc alone
  // cannot open the tree after typing or other shortcuts.
  tab.lastEscapeTime = undefined;
}

export function armPendingEscape(tab: MixCodeTabInfo, now = Date.now()): void {
  tab.pendingEscapeArmedAt = now;
}

export function hasPendingEscape(tab: MixCodeTabInfo, now = Date.now()): boolean {
  if (isPendingEscapeActive(tab, now)) return true;
  if (tab.pendingEscapeArmedAt !== undefined) clearPendingEscape(tab);
  return false;
}

export function isPendingEscapeActive(tab: MixCodeTabInfo, now = Date.now()): boolean {
  const armedAt = tab.pendingEscapeArmedAt;
  if (typeof armedAt !== "number") return false;
  return now - armedAt <= PENDING_ESCAPE_CONFIRM_WINDOW_MS;
}
