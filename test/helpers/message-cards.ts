import {
  SettingsManager,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { entriesToChatLines } from "../../src/agent/runtime-chat.js";
import { testRuntimeTab } from "./runtime-tab.js";

export function summaryChat(summary = "Retain the **design decision**.", tokensBefore = 12_000) {
  const entries: SessionEntry[] = [
    {
      type: "branch_summary",
      id: "branch-summary",
      parentId: null,
      timestamp: "2026-09-09T08:00:00.000Z",
      summary,
      fromId: "source-branch",
    },
    {
      type: "compaction",
      id: "compaction-summary",
      parentId: "branch-summary",
      timestamp: "2026-09-09T08:01:00.000Z",
      summary,
      tokensBefore,
      firstKeptEntryId: "branch-summary",
    },
  ];
  return entriesToChatLines(
    entries,
    testRuntimeTab({
      session: SessionManager.inMemory(),
      agentSession: { settingsManager: SettingsManager.inMemory({ showCacheMissNotices: false }) },
    }),
  );
}
