// In-place reload of a RuntimeTab's session from its own file on disk.
//
// When another mixcode-pi instance appends to the same session JSONL, this
// re-reads the file through the Pi SDK (SessionManager.setSessionFile), then
// re-derives everything downstream: the agent's LLM context messages, the chat
// line model, the preview, and context-usage stats. It deliberately does NOT
// rebuild the AgentSession/services/extensions — only the session-derived view
// changes, so this stays cheap relative to a full session replacement.
import { existsSync } from "node:fs";
import { disposeChatRenderers, entriesToChatLines, syncContextUsage, syncPreviewFromChat } from "./runtime-chat.js";
import type { ChatLine, RuntimeTab } from "./runtime-types.js";

export interface ReloadSessionResult {
  reloaded: boolean;
  reason?: "streaming" | "compacting" | "no-file";
}

/**
 * Reload the tab's session from disk and refresh derived UI/context state.
 *
 * Refuses to reload while the local agent is streaming or compacting: those own
 * the in-memory message list and the session file, and a concurrent reload
 * would clobber live state. Callers must serialize their own writes with the
 * cross-process turn lock so a remote instance cannot append during our turn.
 */
export function reloadRuntimeSessionFromDisk(runtimeTab: RuntimeTab): ReloadSessionResult {
  if (runtimeTab.agentSession.isStreaming) return { reloaded: false, reason: "streaming" };
  if (runtimeTab.agentSession.isCompacting) return { reloaded: false, reason: "compacting" };
  const file = runtimeTab.session.getSessionFile();
  if (!file) return { reloaded: false, reason: "no-file" };
  // A fresh session has a file PATH but no file on disk until its first flush.
  // SessionManager.setSessionFile() treats a non-existent path as "start a new
  // session" and mints a NEW session id (keeping the old filename), which
  // silently changes getSessionId() with no session_start event. That orphans
  // any per-session extension state keyed on the id (e.g. the todo overlay is
  // registered under the original id but tool_execution_end then reports the
  // new id, so its widget never renders until /reload). Nothing on disk means
  // no external appends to reconcile, so skip the reload entirely.
  if (!existsSync(file)) return { reloaded: false, reason: "no-file" };

  // Capture the pre-reload leaf and known entry ids. setSessionFile rebuilds the
  // index and unconditionally moves the leaf to the file's LAST entry — correct
  // for a genuine external append, but wrong after a local retract
  // (navigateTree/resetLeaf rewinds the in-memory leaf while the append-only
  // file keeps the retracted entries). Without this guard, any reload after a
  // retract — including prompt()'s pre-send reload — resurrects the retracted
  // message.
  const prevLeafId = runtimeTab.session.getLeafId();
  const knownIds = new Set(runtimeTab.session.getEntries().map((entry) => entry.id));

  // Re-read the JSONL. Any external appends are now visible.
  runtimeTab.session.setSessionFile(file);

  // A real external append introduces entries we did not previously know. If the
  // file grew only with entries we already had (the retract-then-reload case),
  // restore the rewound leaf instead of jumping to the file tail.
  const reloadedEntries = runtimeTab.session.getEntries();
  const hasNewEntries = reloadedEntries.some((entry) => !knownIds.has(entry.id));
  const entriesChanged = hasNewEntries || reloadedEntries.length !== knownIds.size;
  if (!hasNewEntries) {
    if (prevLeafId === null) {
      runtimeTab.session.resetLeaf();
    } else if (runtimeTab.session.getEntry(prevLeafId)) {
      runtimeTab.session.branch(prevLeafId);
    }
  }
  // ponytail: single-writer model. If this instance retracts while another
  // instance appends to the same session, the new entry counts as "new" and the
  // leaf advances to the file tail, resurrecting the retracted message. Rare
  // under the turn lock; upgrade to descendant-aware reconciliation if needed.

  // Keep in-memory-only Pi UI notifications when the disk entry set is unchanged.
  // Rebuilding chat here would erase ctx.ui.notify() lines before every local prompt.
  if (entriesChanged) {
    // The agent's LLM context must reflect the reloaded branch, or the next turn
    // would send a stale message list even though the UI looks up to date.
    runtimeTab.agent.state.messages = runtimeTab.session.buildSessionContext().messages;

    const nextChat: ChatLine[] = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
    disposeChatRenderers(runtimeTab.chat);
    runtimeTab.chat = nextChat;
    syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
    syncContextUsage(runtimeTab);
  }
  return { reloaded: true };
}
