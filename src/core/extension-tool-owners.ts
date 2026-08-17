import type { SourceInfo } from "@earendil-works/pi-coding-agent";

export function displayToolOwner(sourceInfo: SourceInfo | undefined): string {
  if (!sourceInfo) return "unknown";
  return sourceInfo.source || sourceInfo.path || "unknown";
}
