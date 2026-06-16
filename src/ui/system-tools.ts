import { stringifyJson } from "../core/json.js";
import type { RuntimeToolInfo } from "./app-types.js";

export function renderSystemToolsText(tools: RuntimeToolInfo[]): string {
  if (tools.length === 0) return ["System Tools", "", "No tools available."].join("\n");
  return [
    "System Tools",
    "",
    ...tools
      .map((tool) => formatSystemTool(tool))
      .join("\n\n")
      .split("\n"),
  ].join("\n");
}

function formatSystemTool(tool: RuntimeToolInfo): string {
  const name = String(tool.name ?? "(unnamed)");
  const lines = [`## ${name}`];
  if (typeof tool.description === "string" && tool.description.trim())
    lines.push(tool.description.trim());
  const source = formatToolSource(tool.sourceInfo);
  if (source) lines.push(`source: ${source}`);
  if (tool.parameters !== undefined)
    lines.push("parameters:", stringifyJson(tool.parameters, true));
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
