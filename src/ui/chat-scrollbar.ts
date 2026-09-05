import {
  calculateScrollbarGeometry,
  paintScrollbarCell,
  type ScrollbarGeometry,
} from "@earendil-works/pi-tui";
import type { MixCodeTabInfo } from "../core/types.js";
import type { ScrolledLinesResult } from "./rendering/layout.js";
import { padLine } from "./rendering/primitives.js";
import type { MixCodeTheme } from "./themes.js";

const scrollbars = new WeakMap<MixCodeTabInfo, ChatScrollbar>();

/** Presentation state only; the tab and its windowed renderer own scroll offsets. */
export function chatScrollbarFor(tab: MixCodeTabInfo): ChatScrollbar {
  let scrollbar = scrollbars.get(tab);
  if (!scrollbar) {
    scrollbar = new ChatScrollbar();
    scrollbars.set(tab, scrollbar);
  }
  return scrollbar;
}

export class ChatScrollbar {
  geometry?: ScrollbarGeometry;
  grabOffset?: number;
  requestRender?: () => void;
  private hovered = false;

  get active(): boolean {
    return this.hovered || this.grabOffset !== undefined;
  }

  hover(hovered: boolean): void {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.requestRender?.();
  }

  /** Release pointer capture when the UI owner changes or stops. */
  reset(): void {
    this.hovered = false;
    this.grabOffset = undefined;
    this.geometry = undefined;
  }

  render(
    result: ScrolledLinesResult,
    width: number,
    theme: MixCodeTheme,
    hasNewContent: boolean,
  ): string[] {
    const geometry =
      result.scrollable && width >= 2
        ? calculateScrollbarGeometry({
            column: width - 1,
            trackTop: 0,
            trackHeight: result.lines.length,
            contentHeight: result.total,
            scrollTop: result.start,
          })
        : undefined;
    if (!geometry) {
      this.reset();
    } else if (
      this.geometry &&
      (this.geometry.column !== geometry.column ||
        this.geometry.trackHeight !== geometry.trackHeight)
    ) {
      this.grabOffset = undefined;
      this.hover(false);
    }
    this.geometry = geometry;
    // A dedicated gutter keeps the scrollbar out of chat text and selection.
    return result.lines.map((line, row) => {
      let rendered = padLine(line, width);
      if (geometry) {
        const thumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
        const cell = thumb
          ? theme.scrollbarThumb(this.active ? "\u2588" : "\u2503")
          : theme.scrollbarTrack("\u2502");
        rendered = paintScrollbarCell(rendered, geometry.column, width, cell, true);
      }
      // Preserve the existing unread-stream cue at the bottom of the gutter.
      if (geometry && hasNewContent && row === result.lines.length - 1) {
        rendered = paintScrollbarCell(
          rendered,
          geometry.column,
          width,
          theme.accent("\u2193"),
          true,
        );
      }
      return rendered;
    });
  }
}
