import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatLine } from "../agent/runtime.js";
import type { MixCodeTabInfo } from "../core/types.js";

interface ScrollTargetResult {
  found: boolean;
}

export function scrollChatToUserEntry(
  tab: MixCodeTabInfo,
  chat: ChatLine[],
  branch: SessionEntry[],
  entryId: string,
): ScrollTargetResult {
  const exactIndex = chat.findIndex((line) => isUserChatLine(line) && line.entryId === entryId);
  const targetIndex =
    exactIndex >= 0 ? exactIndex : userChatIndexByBranchOrdinal(chat, branch, entryId);
  if (targetIndex < 0) return { found: false };

  const targetLine = chat[targetIndex];
  tab.chatAtHome = false;
  tab.chatHomeOffset = undefined;
  tab.chatScrollAnchorEntryId = entryId;
  tab.chatScrollAnchorIndex = targetIndex;
  tab.chatScrollAnchorText = targetLine?.text;
  tab.chatScrollOffset = 0;
  return { found: true };
}

export function userMessageEntryIdsInBranch(branch: SessionEntry[]): string[] {
  return branch
    .filter((entry) => entry.type === "message" && entry.message.role === "user")
    .map((entry) => entry.id);
}

function userChatIndexByBranchOrdinal(
  chat: ChatLine[],
  branch: SessionEntry[],
  entryId: string,
): number {
  const entryIds = userMessageEntryIdsInBranch(branch);
  const targetOrdinal = entryIds.indexOf(entryId);
  if (targetOrdinal < 0) return -1;

  let userOrdinal = -1;
  for (let i = 0; i < chat.length; i++) {
    if (!isUserChatLine(chat[i]!)) continue;
    userOrdinal++;
    if (userOrdinal === targetOrdinal) return i;
  }
  return -1;
}

function isUserChatLine(line: ChatLine): boolean {
  return line.role === "user" && line.variant !== "user-bash";
}
