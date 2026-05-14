import type { SessionTreeNode } from "./tree-selector.js";

/** Tool call info for lookup */
export interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
}

// --- Content helpers ---

export function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
        const text = (c as { text?: string }).text;
        if (text && text.trim().length > 0) return true;
      }
    }
  }
  return false;
}

export function extractContent(content: unknown): string {
  const maxLen = 200;
  if (typeof content === "string") return content.slice(0, maxLen);
  if (Array.isArray(content)) {
    let result = "";
    for (const c of content) {
      if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
        result += (c as { text: string }).text;
        if (result.length >= maxLen) return result.slice(0, maxLen);
      }
    }
    return result;
  }
  return "";
}

export function getSearchableText(
  node: SessionTreeNode,
  toolCallMap: Map<string, ToolCallInfo>,
): string {
  const entry = node.entry;
  const parts: string[] = [];

  if (node.label) parts.push(node.label);

  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      parts.push(msg.role);
      if ("content" in msg && msg.content) {
        parts.push(extractContent(msg.content));
      }
      if (msg.role === "toolResult") {
        const toolMsg = msg as { toolCallId?: string; toolName?: string };
        if (toolMsg.toolCallId) {
          const tc = toolCallMap.get(toolMsg.toolCallId);
          if (tc) parts.push(tc.name);
        }
      }
      if (msg.role === "bashExecution") {
        const bashMsg = msg as { command?: string };
        if (bashMsg.command) parts.push(bashMsg.command);
      }
      break;
    }
    case "custom_message":
      parts.push(entry.customType);
      if (typeof entry.content === "string") {
        parts.push(entry.content);
      } else {
        parts.push(extractContent(entry.content));
      }
      break;
    case "compaction":
      parts.push("compaction");
      break;
    case "branch_summary":
      parts.push("branch summary", entry.summary);
      break;
    case "session_info":
      parts.push("title");
      if (entry.name) parts.push(entry.name);
      break;
    case "model_change":
      parts.push("model", entry.modelId);
      break;
    case "thinking_level_change":
      parts.push("thinking", entry.thinkingLevel);
      break;
    case "custom":
      parts.push("custom", entry.customType);
      break;
    case "label":
      parts.push("label", entry.label ?? "");
      break;
  }

  return parts.join(" ");
}

/** Format a tool call for display */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const shortenPath = (p: string): string => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
    return p;
  };

  switch (name) {
    case "read": {
      const path = shortenPath(String(args.path || args.file_path || ""));
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let display = path;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        display += `:${start}${end ? `-${end}` : ""}`;
      }
      return `[read: ${display}]`;
    }
    case "write": {
      const path = shortenPath(String(args.path || args.file_path || ""));
      return `[write: ${path}]`;
    }
    case "edit": {
      const path = shortenPath(String(args.path || args.file_path || ""));
      return `[edit: ${path}]`;
    }
    case "bash": {
      const rawCmd = String(args.command || "");
      const cmd = rawCmd.replace(/[\n\t]/g, " ").trim().slice(0, 50);
      return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
    }
    case "grep": {
      const pattern = String(args.pattern || "");
      const path = shortenPath(String(args.path || "."));
      return `[grep: /${pattern}/ in ${path}]`;
    }
    case "find": {
      const pattern = String(args.pattern || "");
      const path = shortenPath(String(args.path || "."));
      return `[find: ${pattern} in ${path}]`;
    }
    case "ls": {
      const path = shortenPath(String(args.path || "."));
      return `[ls: ${path}]`;
    }
    default: {
      const argsStr = JSON.stringify(args).slice(0, 40);
      return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
    }
  }
}
