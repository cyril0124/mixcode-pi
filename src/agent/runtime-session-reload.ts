// In-place reload of a RuntimeTab's session from its own file on disk.
//
// When another mixcode-pi instance appends to the same session JSONL, this
// re-reads the file through the Pi SDK (SessionManager.setSessionFile), then
// re-derives everything downstream: the agent's LLM context messages, the chat
// line model, the preview, and context-usage stats. It deliberately does NOT
// rebuild the AgentSession/services/extensions — only the session-derived view
// changes, so this stays cheap relative to a full session replacement.
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

  // Re-read the JSONL. setSessionFile rebuilds fileEntries + index and points
  // the leaf at the last entry (correct for the append-only linear sessions
  // MixCode writes). Any external appends are now visible.
  runtimeTab.session.setSessionFile(file);

  // The agent's LLM context must reflect the reloaded branch, or the next turn
  // would send a stale message list even though the UI looks up to date.
  runtimeTab.agent.state.messages = runtimeTab.session.buildSessionContext().messages;

  const nextChat: ChatLine[] = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
  disposeChatRenderers(runtimeTab.chat);
  runtimeTab.chat = nextChat;
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  syncContextUsage(runtimeTab);
  return { reloaded: true };
}
