import type { RuntimeToolInfo } from "./app-types.js";
import { renderTokenBreakdown } from "./components/system-prompt-stats.js";

export function renderSystemToolsText(tools: RuntimeToolInfo[]): string {
  if (tools.length === 0) return ["System Tools", "", "No tools available."].join("\n");
  return (
    [
      "System Tools",
      "",
      ...tools
        .map((tool) => formatSystemTool(tool))
        .join("\n\n")
        .split("\n"),
    ].join("\n") + renderSystemToolsStats(tools)
  );
}

// Only the bytes actually sent to the model count: name, description and the
// parameter schema. Display-only decoration (source, headings) is excluded.
function toolPayload(tool: RuntimeToolInfo): string {
  const parts = [
    String(tool.name ?? ""),
    typeof tool.description === "string" ? tool.description : "",
  ];
  if (tool.parameters !== undefined) parts.push(JSON.stringify(tool.parameters));
  return parts.join("\n");
}

function renderSystemToolsStats(tools: RuntimeToolInfo[]): string {
  const rows = tools.map((tool) => ({
    name: String(tool.name ?? "(unnamed)"),
    text: toolPayload(tool),
  }));
  return renderTokenBreakdown(
    "Tool definition breakdown (name + description + parameter schema; token estimates are heuristic: ~4 chars/token, ~1/CJK char):",
    rows,
    rows.map((r) => r.text).join("\n"),
  );
}

function formatSystemTool(tool: RuntimeToolInfo): string {
  const name = String(tool.name ?? "(unnamed)");
  const lines = [`## == ${name} ==`];
  if (typeof tool.description === "string" && tool.description.trim()) {
    lines.push("~~~", tool.description.trim(), "~~~");
  }
  const source = formatToolSource(tool.sourceInfo);
  if (source) lines.push(`source: ${source}`);
  if (tool.parameters !== undefined)
    lines.push("parameters:", JSON.stringify(tool.parameters, null, 2));
  return lines.join("\n");
}

function formatToolSource(sourceInfo: RuntimeToolInfo["sourceInfo"]): string {
  if (!sourceInfo) return "";
  const parts = [
    typeof sourceInfo.source === "string" && sourceInfo.source
      ? displayToolSource(sourceInfo.source)
      : "",
    typeof sourceInfo.scope === "string" && sourceInfo.scope ? sourceInfo.scope : "",
    typeof sourceInfo.origin === "string" && sourceInfo.origin ? sourceInfo.origin : "",
    typeof sourceInfo.path === "string" && sourceInfo.path
      ? displayToolSourcePath(sourceInfo.path)
      : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function displayToolSource(source: string): string {
  if (source === "builtin") return "pi-builtin";
  if (source === "sdk") return "mixcode-custom";
  return source;
}

function displayToolSourcePath(path: string): string {
  return path.replace(/^<builtin:/, "<pi-builtin:").replace(/^<sdk:/, "<mixcode-custom:");
}
