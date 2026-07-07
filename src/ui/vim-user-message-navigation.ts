import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentText } from "../agent/runtime-text.js";
import { chatEnd } from "../core/overlays.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeKeyRuntime } from "./app-types.js";
import { scrollChatToUserEntry, userMessageEntryIdsInBranch } from "./chat-scroll-target.js";

const PREVIEW_TTL_MS = 1_800;
const PREVIEW_WIDTH = 34;
const FALLBACK_PREVIEW_ROWS = 5;

type RuntimeTab = NonNullable<ReturnType<NonNullable<MixCodeKeyRuntime["getTab"]>>>;

export function handleVimUserMessageNavigation(
  active: MixCodeState["tabs"][number],
  data: string,
  runtime?: MixCodeKeyRuntime,
): boolean {
  if (!active.vimMode) return false;
  const jumpPrevious = matchesKey(data, "shift+right");
  const jumpNext = matchesKey(data, "right");
  if (!jumpPrevious && !jumpNext) return false;

  active.vimPendingEscapeAt = undefined;
  active.vimPendingHome = false;

  const runtimeTab = runtime?.getTab?.(active.sessionId);
  const branch = runtimeTab?.session.getBranch?.();
  if (!runtimeTab || !branch) {
    pushToast(active, { type: "warning", message: "User-message navigation requires an active agent chat" });
    return true;
  }

  const userEntryIds = userMessageEntryIdsInBranch(branch);
  if (userEntryIds.length === 0) {
    pushToast(active, { type: "warning", message: "No user messages in current chat" });
    return true;
  }

  const targetId = jumpPrevious
    ? previousUserEntryId(active, userEntryIds)
    : nextUserEntryId(active, userEntryIds);
  if (targetId) scrollToUserEntry(active, runtimeTab, branch, targetId);
  refreshUserMessagePreview(active, branch);
  return true;
}

function scrollToUserEntry(
  active: MixCodeState["tabs"][number],
  runtimeTab: RuntimeTab,
  branch: SessionEntry[],
  targetId: string,
): void {
  const bounds = active.chatSurfaceBounds;
  const result = scrollChatToUserEntry(
    active,
    runtimeTab.chat ?? [],
    branch,
    targetId,
    bounds?.height ?? (process.stdout.rows || 24),
    bounds?.width ?? (process.stdout.columns || 80),
  );
  if (!result.found)
    pushToast(active, { type: "warning", message: "Message is not in the current chat" });
}

function nextUserEntryId(
  active: MixCodeState["tabs"][number],
  userEntryIds: string[],
): string | undefined {
  const currentIndex = active.chatScrollAnchorEntryId
    ? userEntryIds.indexOf(active.chatScrollAnchorEntryId)
    : userEntryIds.length;
  if (currentIndex < 0 || currentIndex >= userEntryIds.length) {
    pushToast(active, { type: "info", message: "No newer user message" });
    return undefined;
  }
  if (currentIndex === userEntryIds.length - 1) {
    chatEnd(active);
    return undefined;
  }
  return userEntryIds[currentIndex + 1];
}

function previousUserEntryId(
  active: MixCodeState["tabs"][number],
  userEntryIds: string[],
): string | undefined {
  let currentIndex = active.chatScrollAnchorEntryId
    ? userEntryIds.indexOf(active.chatScrollAnchorEntryId)
    : userEntryIds.length;
  if (currentIndex < 0) currentIndex = userEntryIds.length;
  if (currentIndex === 0) {
    pushToast(active, { type: "info", message: "No older user message" });
    return undefined;
  }
  return userEntryIds[Math.min(currentIndex, userEntryIds.length) - 1];
}

function refreshUserMessagePreview(
  active: MixCodeState["tabs"][number],
  branch: SessionEntry[],
): void {
  const userEntries = branch.filter(isUserMessageEntry);
  if (userEntries.length === 0) return;

  const entries = [
    ...userEntries.map((entry) => ({ id: entry.id, label: firstTextLine(entry) })),
    { id: "__newest__", label: "<NEWEST>" },
  ];
  const anchoredIndex = active.chatScrollAnchorEntryId
    ? entries.findIndex((entry) => entry.id === active.chatScrollAnchorEntryId)
    : -1;
  const selectedIndex = anchoredIndex >= 0 ? anchoredIndex : entries.length - 1;
  const maxRows = previewRows(active);
  const { lines, highlightedIndex } = previewWindow(entries, selectedIndex, maxRows);
  active.floatingPanel = {
    title: "User Messages",
    lines,
    highlightedIndex,
    width: PREVIEW_WIDTH,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
    style: {
      border: "borderDim",
      title: "borderDim",
      body: "surface",
      highlighted: "selection",
    },
  };
}

function previewRows(active: MixCodeState["tabs"][number]): number {
  const available = active.chatSurfaceBounds?.height;
  if (available === undefined) return FALLBACK_PREVIEW_ROWS;
  return Math.max(3, Math.min(7, available - 2));
}

function previewWindow(
  entries: Array<{ id: string; label: string }>,
  selectedIndex: number,
  maxRows: number,
): { lines: string[]; highlightedIndex: number } {
  const selected = Math.max(0, Math.min(selectedIndex, entries.length - 1));
  let start = Math.max(0, selected - Math.floor(maxRows / 2));
  let end = Math.min(entries.length, start + maxRows);
  start = Math.max(0, end - maxRows);

  for (;;) {
    const older = start;
    const newer = entries.length - end;
    const hintRows = (older > 0 ? 1 : 0) + (newer > 0 ? 1 : 0);
    const messageRows = Math.max(1, maxRows - hintRows);
    const nextStart = Math.max(0, Math.min(selected - Math.floor(messageRows / 2), entries.length - messageRows));
    const nextEnd = Math.min(entries.length, nextStart + messageRows);
    if (nextStart === start && nextEnd === end) break;
    start = nextStart;
    end = nextEnd;
  }

  const lines: string[] = [];
  if (start > 0) lines.push(`↑ ${start} older above`);
  const highlightedIndex = lines.length + selected - start;
  for (let index = start; index < end; index++) lines.push(truncateToWidth(entries[index]!.label, 28));
  if (end < entries.length) lines.push(`↓ ${entries.length - end} newer below`);
  return { lines, highlightedIndex };
}

type UserMessageEntry = SessionEntry & {
  type: "message";
  message: { role: "user"; content: string | Array<{ type: string; text?: string }> };
};

function isUserMessageEntry(entry: SessionEntry): entry is UserMessageEntry {
  return entry.type === "message" && entry.message.role === "user" && "content" in entry.message;
}

function firstTextLine(entry: UserMessageEntry): string {
  const text = contentText(entry.message.content).trim();
  return text.split(/\r?\n/)[0]?.trim() || "(empty user message)";
}
