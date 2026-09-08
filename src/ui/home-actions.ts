import { visibleWidth } from "@earendil-works/pi-tui";
import type { SgrMouseInput } from "../core/mouse.js";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeTheme } from "./themes.js";

export type HomeAction = "new-session" | "resume";

interface ActionRegion {
  action: HomeAction;
  label: string;
  x: number;
  y: number;
}

const actions = new WeakMap<MixCodeState, HomeActions>();

/** Ephemeral presentation state; never stored in workspace or session snapshots. */
export function homeActionsFor(state: MixCodeState): HomeActions {
  let value = actions.get(state);
  if (!value) {
    value = new HomeActions();
    actions.set(state, value);
  }
  return value;
}

export class HomeActions {
  pending = false;
  private regions: ActionRegion[] = [];
  private hovered?: HomeAction;
  private pressed?: HomeAction;
  private viewport = "";

  /** Screen coordinates are one-based, including wrapped tab-bar rows. */
  beginFrame(width: number, height: number | undefined, rowOffset: number): void {
    const viewport = `${width}:${height}:${rowOffset}`;
    if (this.viewport !== viewport) this.reset();
    this.viewport = viewport;
  }

  reset(): void {
    this.regions = [];
    this.hovered = undefined;
    this.pressed = undefined;
  }

  renderHeading(
    heading: string,
    width: number,
    origin: { x: number; y: number },
    theme: MixCodeTheme,
    maxRows: number,
    actionsFirst = false,
  ): string[] {
    const buttons: Array<{ action: HomeAction; label: string }> = [
      { action: "new-session", label: width >= 15 ? " + New session " : " + New " },
      { action: "resume", label: "[ Resume ]" },
    ];
    if (width < buttons[0]!.label.length) {
      this.reset();
      return heading ? [heading] : [];
    }
    if (width < buttons[0]!.label.length + 1 + buttons[1]!.label.length) buttons.pop();
    const buttonWidth =
      buttons.reduce((total, button) => total + button.label.length, 0) + buttons.length - 1;
    const inline = Boolean(heading) && visibleWidth(heading) + 2 + buttonWidth <= width;
    if (!inline && heading && maxRows < 2 && !actionsFirst) {
      this.reset();
      return [heading];
    }
    const separateHeading = !inline && heading && maxRows >= 2;
    const startX = inline ? width - buttonWidth : 0;
    const row = separateHeading ? 1 : 0;
    let column = startX;
    const regions = buttons.map((button) => {
      const region = { ...button, x: origin.x + column, y: origin.y + row };
      column += button.label.length + 1;
      return region;
    });
    if (
      this.regions.length !== regions.length ||
      regions.some((region, index) => {
        const previous = this.regions[index];
        return (
          previous?.x !== region.x || previous.y !== region.y || previous.label !== region.label
        );
      })
    ) {
      this.reset();
    }
    this.regions = regions;
    const bar = regions.map((region) => this.paint(region, theme)).join(" ");
    if (inline) return [heading + " ".repeat(startX - visibleWidth(heading)) + bar];
    return separateHeading ? [heading, bar] : [bar];
  }

  /** Two-target O(1) hit test. Only state transitions request a repaint. */
  handleMouse(mouse: SgrMouseInput): { consume: boolean; changed: boolean; action?: HomeAction } {
    const region = this.regions.find(
      (region) =>
        mouse.y === region.y && mouse.x >= region.x && mouse.x < region.x + region.label.length,
    );
    const previousHover = this.hovered;
    const previousPress = this.pressed;
    const target = region?.action;
    let action: HomeAction | undefined;
    const primary = mouse.button === 0;
    const passive = mouse.motion && mouse.button === 3;
    if (!mouse.wheel && (primary || passive)) {
      this.hovered = target;
      if (mouse.release) {
        if (primary && target && target === this.pressed && !this.pending) action = target;
        this.pressed = undefined;
      } else if (mouse.motion) {
        // Leaving a pressed target cancels, even if the pointer later returns.
        if (target !== this.pressed || passive) this.pressed = undefined;
      } else if (primary && !this.pending) {
        this.pressed = target;
      }
    } else {
      this.pressed = undefined;
    }
    return {
      consume: Boolean(previousPress || (target && !mouse.wheel && (primary || passive))),
      changed: previousHover !== this.hovered || previousPress !== this.pressed,
      action,
    };
  }

  private paint(region: ActionRegion, theme: MixCodeTheme): string {
    if (this.pending) return theme.dim(region.label);
    const hovered = this.hovered === region.action;
    const pressed = this.pressed === region.action;
    const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`;
    if (region.action === "new-session") {
      const label = theme.accent(theme.bold(region.label));
      if (pressed) return theme.selectedBg(label);
      return inverse(hovered ? `\x1b[4m${label}\x1b[24m` : label);
    }
    if (pressed) return inverse(theme.accent(theme.bold(region.label)));
    if (hovered) return theme.selectedBg(theme.accent(theme.bold(region.label)));
    return theme.borderMuted("[") + theme.text(" Resume ") + theme.borderMuted("]");
  }
}
