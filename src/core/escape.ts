import type { MixCodeTabInfo, PendingEscapeAction } from "./types.js";

export const PENDING_ESCAPE_CONFIRM_WINDOW_MS = 1_000;

export function clearPendingEscape(tab: MixCodeTabInfo, action: PendingEscapeAction): void {
  if (tab.pendingEscapeAction === action) {
    tab.pendingEscapeAction = undefined;
    tab.pendingEscapeArmedAt = undefined;
  }
  // Callers use this on non-Esc keys to cancel confirm arms; also cancel the
  // empty-editor double-Esc tree/fork arm (lastEscapeTime) so a later Esc alone
  // cannot open the tree after typing or other shortcuts.
  tab.lastEscapeTime = undefined;
}

export function armPendingEscape(
  tab: MixCodeTabInfo,
  action: PendingEscapeAction,
  now = Date.now(),
): void {
  tab.pendingEscapeAction = action;
  tab.pendingEscapeArmedAt = now;
}

export function hasPendingEscape(
  tab: MixCodeTabInfo,
  action: PendingEscapeAction,
  now = Date.now(),
): boolean {
  if (isPendingEscapeActive(tab, action, now)) return true;
  if (tab.pendingEscapeAction === action) clearPendingEscape(tab, action);
  return false;
}

export function isPendingEscapeActive(
  tab: MixCodeTabInfo,
  action: PendingEscapeAction,
  now = Date.now(),
): boolean {
  if (tab.pendingEscapeAction !== action) return false;
  const armedAt = tab.pendingEscapeArmedAt;
  if (typeof armedAt !== "number") return false;
  return now - armedAt <= PENDING_ESCAPE_CONFIRM_WINDOW_MS;
}
