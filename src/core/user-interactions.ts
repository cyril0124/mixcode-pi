import type { MixCodeTabInfo } from "./types.js";

export function tabHasPendingUserInteraction(tab: MixCodeTabInfo): boolean {
  return tab.pendingQuestions.length > 0 || tab.extensionUi.pendingUserInteractions.length > 0;
}
