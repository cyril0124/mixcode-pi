import {
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { editTextInExternalEditor } from "../core/external-editor.js";
import { closeCommandPalette, closeTabJump } from "../core/overlays.js";
import type { MixCodeState } from "../core/types.js";
import type { OverlayTui } from "./app-types.js";
import { overlayPanel, padLine } from "./rendering.js";

const activeOverlayHandles = new WeakMap<object, OverlayHandle>();

class LinesOverlay implements Component {
  constructor(private readonly renderLines: (width: number) => string[]) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderLines(width)
      .flatMap((line) => line.split(/\r?\n/))
      .map((line) => padLine(line, width));
  }
}
export function showTextOverlay(tui: OverlayTui, text: string, options?: OverlayOptions): void {
  showLinesOverlay(tui, () => text.split(/\r?\n/), options);
}

export function showLinesOverlay(
  tui: OverlayTui,
  renderLines: (width: number) => string[],
  options: OverlayOptions = defaultOverlayOptions(),
): void {
  closeAppOverlay(tui);
  const handle = tui.showOverlay(new LinesOverlay(renderLines), options);
  if (isOverlayHandle(handle)) activeOverlayHandles.set(tui, handle);
}

export function closeAppOverlay(tui: OverlayTui): void {
  const handle = activeOverlayHandles.get(tui);
  if (handle) {
    handle.hide();
    activeOverlayHandles.delete(tui);
    return;
  }
  if (tui.hasOverlay?.()) tui.hideOverlay?.();
}

export function hasAppOverlay(tui: OverlayTui): boolean {
  return activeOverlayHandles.has(tui);
}

export function hasAnyOverlay(tui: OverlayTui): boolean {
  return activeOverlayHandles.has(tui) || (tui.hasOverlay?.() ?? false);
}

function isOverlayHandle(value: unknown): value is OverlayHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OverlayHandle).hide === "function"
  );
}

function defaultOverlayOptions(): OverlayOptions {
  return {
    anchor: "center",
    width: "78%",
    maxHeight: "80%",
    margin: 1,
  };
}

export function quitOverlayOptions(): OverlayOptions {
  return {
    anchor: "center",
    width: 72,
    margin: 1,
  };
}

export function renderQuitConfirm(width: number): string[] {
  return overlayPanel(
    "Quit MixCode",
    ["Are you sure you want to quit?", "", "[Y] Quit    [N] Cancel", "Esc: cancel"],
    width,
  );
}

export function showTransientTextOverlay(tui: OverlayTui, text: string): void {
  showTextOverlay(tui, text, compactToastOverlayOptions(text));
}

export function showErrorOverlay(tui: OverlayTui, error: unknown): void {
  showTransientTextOverlay(tui, errorMessage(error));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactToastOverlayOptions(text: string): OverlayOptions {
  const contentWidth = Math.max(...text.split(/\r?\n/).map((line) => visibleWidth(line)), 0);
  return {
    anchor: "bottom-center",
    width: Math.max(18, Math.min(56, contentWidth + 4)),
    maxHeight: 6,
    margin: 1,
    offsetY: -4,
    nonCapturing: true,
  };
}

export async function editTextWithTuiPaused(
  tui: OverlayTui,
  text: string,
  editor?: string,
): Promise<string> {
  const canPause = Boolean(tui.stop && tui.start);
  if (canPause) tui.stop?.();
  try {
    return await editTextInExternalEditor(text, { editor });
  } finally {
    if (canPause) {
      tui.start?.();
      tui.requestRender(true);
    }
  }
}
