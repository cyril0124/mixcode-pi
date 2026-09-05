import type { OverlayBounds } from "@earendil-works/pi-tui";
import { parseSgrMouseInput, type SgrMouseInput } from "../../core/mouse.js";

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
  /**
   * Compositor-rendered overlay rectangle (0-based, maxHeight already clamped
   * by pi-tui). Undefined until the overlay's first render.
   */
  bounds: () => OverlayBounds | undefined;
}

/** Map a screen click onto a visible list-overlay entry index, or undefined. */
export function hitTestListOverlay(
  plan: ListOverlayPlan,
  mouse: Pick<SgrMouseInput, "x" | "y">,
  bounds: OverlayBounds,
): number | undefined {
  if (plan.empty) return undefined;
  // mouse is 1-based; compositor bounds row/col are 0-based.
  if (mouse.x < bounds.col + 1 || mouse.x > bounds.col + bounds.width) return undefined;
  const lineIndex = mouse.y - (bounds.row + 1);
  // Rendered body rows are lineIndex 1..height-2; line 0 is the top border,
  // height-1 the bottom border, and anything past height was sliced by the
  // compositor's maxHeight clamp even if the plan still lists an entry there.
  if (lineIndex < 1 || lineIndex > bounds.height - 2) return undefined;
  const bodyLine = lineIndex - 1;
  return plan.entryBodyLines.find((hit) => hit.bodyLine === bodyLine)?.entryIndex;
}

/**
 * Wheel moves selection; click accepts the row under the cursor.
 * Returns false when `data` is not SGR mouse (so key handlers can continue).
 */
export function handleListOverlayMouse(data: string, handlers: ListOverlayMouseHandlers): boolean {
  const mouse = parseSgrMouseInput(data);
  if (!mouse) return false;
  if (handlers.isOpen && !handlers.isOpen()) return true;
  if (mouse.wheel) {
    handlers.onMove(mouse.wheel === "up" ? -1 : 1);
    handlers.reshow();
    return true;
  }
  if (mouse.button === 0 && !mouse.release && !mouse.motion) {
    const bounds = handlers.bounds();
    if (!bounds) return true; // not rendered yet — nothing visible to click
    const entryIndex = hitTestListOverlay(handlers.plan(), mouse, bounds);
    if (entryIndex !== undefined) handlers.onAccept(entryIndex);
    return true;
  }
  // Swallow drag/release so they cannot leak into chrome or chat.
  return true;
}
