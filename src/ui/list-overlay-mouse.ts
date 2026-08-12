import type { OverlayOptions } from "@earendil-works/pi-tui";
import { parseSgrMouseInput, type SgrMouseInput } from "../core/mouse.js";
import { defaultOverlayOptions, resolveAppOverlayLayout } from "./app-overlays.js";

/** Geometry shared by center list overlays (Tab Jump, Command Palette, …). */
export interface ListOverlayPlan {
  empty: boolean;
  /** Body lines inside the box (under the top border), before bottom border. */
  bodyLineCount: number;
  /** 0-based body line → absolute entry index in the filtered list. */
  entryBodyLines: Array<{ bodyLine: number; entryIndex: number }>;
}

export interface ListOverlayMouseHandlers {
  /** Fresh plan for hit-testing (call after each event if selection can change). */
  plan: () => ListOverlayPlan;
  onMove: (delta: number) => void;
  onAccept: (entryIndex: number) => void;
  reshow: () => void;
  /** Overlay open gate; when false, hit-test returns undefined. */
  isOpen?: () => boolean;
  options?: OverlayOptions;
}

/** Map a screen click onto a visible list-overlay entry index, or undefined. */
export function hitTestListOverlay(
  plan: ListOverlayPlan,
  mouse: Pick<SgrMouseInput, "x" | "y">,
  options: OverlayOptions = defaultOverlayOptions(),
  termWidth = process.stdout.columns || 80,
  termHeight = process.stdout.rows || 24,
): number | undefined {
  if (plan.empty) return undefined;
  // Body lines + top/bottom box borders — matches overlayPanel output height.
  const overlayHeight = plan.bodyLineCount + 2;
  const layout = resolveAppOverlayLayout(options, overlayHeight, termWidth, termHeight);
  const effectiveHeight =
    layout.maxHeight !== undefined ? Math.min(overlayHeight, layout.maxHeight) : overlayHeight;
  // mouse is 1-based; pi-tui layout row/col are 0-based.
  if (mouse.x < layout.col + 1 || mouse.x > layout.col + layout.width) return undefined;
  const lineIndex = mouse.y - (layout.row + 1);
  if (lineIndex < 0 || lineIndex >= effectiveHeight) return undefined;
  const bodyLine = lineIndex - 1; // line 0 is the top border
  return plan.entryBodyLines.find((hit) => hit.bodyLine === bodyLine)?.entryIndex;
}

/**
 * Wheel moves selection; click accepts the row under the cursor.
 * Returns false when `data` is not SGR mouse (so key handlers can continue).
 */
export function handleListOverlayMouse(
  data: string,
  handlers: ListOverlayMouseHandlers,
  termWidth = process.stdout.columns || 80,
  termHeight = process.stdout.rows || 24,
): boolean {
  const mouse = parseSgrMouseInput(data);
  if (!mouse) return false;
  if (handlers.isOpen && !handlers.isOpen()) return true;
  if (mouse.wheel) {
    handlers.onMove(mouse.wheel === "up" ? -1 : 1);
    handlers.reshow();
    return true;
  }
  if (mouse.button === 0 && !mouse.release && !mouse.motion) {
    const entryIndex = hitTestListOverlay(
      handlers.plan(),
      mouse,
      handlers.options ?? defaultOverlayOptions(),
      termWidth,
      termHeight,
    );
    if (entryIndex !== undefined) handlers.onAccept(entryIndex);
    return true;
  }
  // Swallow drag/release so they cannot leak into chrome or chat.
  return true;
}
