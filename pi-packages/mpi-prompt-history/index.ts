// +----------------------------------------------------------------------+
// |  prompt-history extension                                            |
// |  Registers /prompt-history --> opens history browser --> fills editor|
// +----------------------------------------------------------------------+
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openPromptHistoryBrowser } from "./prompt-history-browser.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prompt-history", {
    description: "Browse current session's prompt history",
    handler: async (_args, ctx) => {
      // Extract user messages from session entries
      const entries = ctx.sessionManager.getEntries();
      const userMessages: Array<{ text: string; timestamp?: string }> = [];

      for (const entry of entries) {
        if (entry.type === "message" && entry.message?.role === "user") {
          const msg = entry.message;
          const content = msg.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
          }
          if (text.length > 0) {
            userMessages.push({
              text,
              timestamp: entry.timestamp,
            });
          }
        }
      }

      if (userMessages.length === 0) {
        ctx.ui.notify("No prompt history in current session.", "info");
        return;
      }

      const selected = await openPromptHistoryBrowser(userMessages, ctx);
      if (selected) {
        ctx.ui.setEditorText(selected);
      }
    },
  });
}
