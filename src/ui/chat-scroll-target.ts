import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatLine } from "../agent/runtime.js";
import type { MixCodeTabInfo } from "../core/types.js";
import { renderChatBlock } from "./rendering/chat.js";

export interface ScrollTargetResult {
  found: boolean;
  offsetChanged: boolean;
}

export function scrollChatToUserEntry(
  tab: MixCodeTabInfo,
  chat: ChatLine[],
  branch: SessionEntry[],
  entryId: string,
  viewportHeight: number,
  width: number,
): ScrollTargetResult {
  const exactIndex = chat.findIndex((line) => isUserChatLine(line) && line.entryId === entryId);
  const targetIndex = exactIndex >= 0 ? exactIndex : userChatIndexByBranchOrdinal(chat, branch, entryId);
  if (targetIndex < 0) return { found: false, offsetChanged: false };

  const normalizedWidth = Math.max(1, Math.floor(width));
  const blocks = chat.map((line) => renderChatBlock(line, normalizedWidth, tab));
  const targetStart = rowsBeforeBlock(blocks, targetIndex);
  const totalRows = totalChatRows(blocks);
  const viewport = Math.max(1, Math.floor(viewportHeight));
  const maxOffset = Math.max(0, totalRows - viewport);

  // chatScrollOffset is bottom-anchored: 0 means latest content. Aligning a
  // selected block to the top means making the viewport start at targetStart.
  const topAlignedOffset = totalRows - viewport - targetStart;
  const nextOffset = Math.max(0, Math.min(maxOffset, topAlignedOffset));
  const offsetChanged = tab.chatScrollOffset !== nextOffset;
  tab.chatScrollOffset = nextOffset;
  return { found: true, offsetChanged };
}

export function userMessageEntryIdsInBranch(branch: SessionEntry[]): string[] {
  return branch
    .filter((entry) => entry.type === "message" && entry.message.role === "user")
    .map((entry) => entry.id);
}

function userChatIndexByBranchOrdinal(chat: ChatLine[], branch: SessionEntry[], entryId: string): number {
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

function totalChatRows(blocks: string[][]): number {
  let total = 0;
  let seenNonEmpty = false;
  for (const block of blocks) {
    if (block.length === 0) continue;
    if (seenNonEmpty) total += 1;
    total += block.length;
    seenNonEmpty = true;
  }
  return total;
}

function rowsBeforeBlock(blocks: string[][], index: number): number {
  let total = 0;
  let seenNonEmpty = false;
  for (let i = 0; i < index; i++) {
    const block = blocks[i];
    if (!block || block.length === 0) continue;
    if (seenNonEmpty) total += 1;
    total += block.length;
    seenNonEmpty = true;
  }
  if (seenNonEmpty && (blocks[index]?.length ?? 0) > 0) total += 1;
  return total;
}
