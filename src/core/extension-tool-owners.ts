import type { SourceInfo } from "@earendil-works/pi-coding-agent";

export type ExtensionToolOwnerPolicy = (sourceInfo: SourceInfo | undefined, toolName: string) => boolean;

export function isExtensionToolOwner(
  sourceInfo: SourceInfo | undefined,
  _toolName: string,
): boolean {
  return !!sourceInfo && sourceInfo.source !== "builtin";
}

export function displayToolOwner(sourceInfo: SourceInfo | undefined): string {
  if (!sourceInfo) return "unknown";
  return sourceInfo.source || sourceInfo.path || "unknown";
}
