import { compositeTuiLine, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { MixCodeTheme } from "./themes.js";

/** One-based screen rectangle matching a clickable target's visible cells. */
export interface HoverTarget {
  id: string;
  x: number;
  y: number;
  width: number;
  height?: number;
}

/** Pointer focus is presentation-only and never changes keyboard selection. */
export class PointerHover {
  private targets: readonly HoverTarget[] = [];
  private hovered?: HoverTarget;
  private revision?: string;

  get id(): string | undefined {
    return this.hovered?.id;
  }

  /** Geometry changes cancel the old highlight rather than transferring it to another item. */
  layout(targets: readonly HoverTarget[], revision?: string): void {
    if (this.revision !== revision) this.clear();
    this.revision = revision;
    if (this.hovered) {
      const previous = this.hovered;
      this.hovered = targets.find(
        (target) =>
          target.id === previous.id &&
          target.x === previous.x &&
          target.y === previous.y &&
          target.width === previous.width &&
          target.height === previous.height,
      );
    }
    this.targets = targets;
  }

  move(x: number, y: number): boolean {
    const target = this.targets.find(
      (target) =>
        x >= target.x &&
        x < target.x + target.width &&
        y >= target.y &&
        y < target.y + (target.height ?? 1),
    );
    const changed = this.hovered?.id !== target?.id;
    this.hovered = target;
    return changed;
  }

  clear(): boolean {
    const changed = this.hovered !== undefined;
    this.hovered = undefined;
    return changed;
  }

  reset(): void {
    this.clear();
    this.targets = [];
  }

  /** Paint only the hovered cells; dimensions and semantic foreground colors are preserved. */
  paint(lines: string[], width: number, theme: MixCodeTheme, rowOffset = 0): string[] {
    const target = this.hovered;
    if (!target) return lines;
    const result = lines.slice();
    for (
      let row = target.y - 1 - rowOffset;
      row < target.y - 1 - rowOffset + (target.height ?? 1);
      row++
    ) {
      const line = result[row];
      if (line === undefined) continue;
      const start = target.x - 1;
      const cell = sliceByColumn(line, start, target.width, true);
      result[row] = compositeTuiLine(
        line,
        paintHover(cell, theme),
        start,
        visibleWidth(cell),
        width,
      );
    }
    return result;
  }
}

/** Underline distinguishes hover from selection even in monochrome themes. */
export function paintHover(text: string, theme: MixCodeTheme): string {
  const marked = theme.selectedBg("\x01");
  const open = marked.slice(0, marked.indexOf("\x01"));
  // Existing chip/row backgrounds must not mask hover; keep their foregrounds.
  return theme.selectedBg(
    `\x1b[4m${text.replace(/\x1b\[[0-9;:]*m/g, (sequence) => `${sequence}${open}\x1b[4m`)}\x1b[24m`,
  );
}

const hovers = new WeakMap<object, Map<string, PointerHover>>();

export function pointerHoverFor(owner: object, scope: string): PointerHover {
  let scopes = hovers.get(owner);
  if (!scopes) {
    scopes = new Map();
    hovers.set(owner, scopes);
  }
  let hover = scopes.get(scope);
  if (!hover) {
    hover = new PointerHover();
    scopes.set(scope, hover);
  }
  return hover;
}
