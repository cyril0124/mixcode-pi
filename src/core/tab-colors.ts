/**
 * Named tab colors. This list is the source of truth for valid names: command
 * arguments and state files validate against it, and `src/ui/themes.ts`
 * (`tabColorPaint`) must define an ANSI pair for every entry.
 */

export const TAB_COLOR_NAMES = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
] as const;

export type TabColorName = (typeof TAB_COLOR_NAMES)[number];

const TAB_COLOR_SET: ReadonlySet<string> = new Set(TAB_COLOR_NAMES);

/** True for a known tab color name, used to validate command arguments and state files. */
export function isTabColorName(value: unknown): value is TabColorName {
  return typeof value === "string" && TAB_COLOR_SET.has(value);
}
