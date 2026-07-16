/**
 * Shared "current MixCode UI theme id" for extension rendering.
 * Updated whenever the user (or extension) switches theme so footer/widget/
 * custom/message renderers can follow without a hard dependency cycle.
 */
let activeExtensionThemeId = "mixcode-dark";

export function noteActiveExtensionThemeId(themeId: string): void {
  const normalized = themeId.trim();
  if (normalized) activeExtensionThemeId = normalized;
}

export function getActiveExtensionThemeId(): string {
  return activeExtensionThemeId;
}
