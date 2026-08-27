/**
 * Fork selector: lists user messages as fork points, newest last. Selecting one
 * calls extensionFork(entryId) which branches the session to that message and
 * refills the editor with that message text (SDK fork semantics).
 *
 * Upstream pi component style: self-contained class with local state and
 * callbacks. Input arrives via TUI focus (showComponentOverlay focuses the
 * overlay), so no global key-dispatch branch is involved.
 */

import {
  SelectList,
  truncateToWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { MixCodeState } from "../../core/types.js";
import type { MixCodeKeyRuntime, OverlayTui } from "../app-types.js";
import { closeAppOverlay, showComponentOverlay } from "../app-overlays.js";
import { overlayPanel } from "../rendering/primitives.js";
import { activeRenderTheme, renderWithTheme } from "../rendering/context.js";
import { themeForId, type MixCodeTheme } from "../themes.js";

export interface ForkPoint {
  entryId: string;
  text: string;
}

export interface ForkSelectorCallbacks {
  onSelect: (entryId: string) => void;
  onCancel: () => void;
}

const MAX_VISIBLE = 15;

export class ForkSelector implements Component {
  private readonly list: SelectList;

  constructor(
    items: readonly ForkPoint[],
    private readonly getTheme: () => MixCodeTheme,
    callbacks: ForkSelectorCallbacks,
  ) {
    this.list = new SelectList(
      // Collapse whitespace so multi-line messages render as one preview line;
      // width truncation happens in the layout callback at render time.
      items.map((item) => ({ value: item.entryId, label: item.text.replace(/\s+/g, " ").trim() })),
      MAX_VISIBLE,
      {
        selectedPrefix: (text) => activeRenderTheme.selectedBg(text),
        selectedText: (text) => activeRenderTheme.selectedBg(text),
        description: (text) => activeRenderTheme.dim(text),
        scrollInfo: (text) => activeRenderTheme.dim(text),
        noMatch: (text) => activeRenderTheme.dim(text),
      },
      { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth) },
    );
    // Default select the newest (last) user message
    this.list.setSelectedIndex(items.length - 1);
    this.list.onSelect = (item: SelectItem) => callbacks.onSelect(item.value);
    this.list.onCancel = callbacks.onCancel;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Keep vim-style j/k on top of the SelectList arrow/enter/escape bindings.
    if (data === "k") {
      this.list.handleInput("\u001b[A");
      return;
    }
    if (data === "j") {
      this.list.handleInput("\u001b[B");
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return renderWithTheme(this.getTheme(), () => {
      const lines: string[] = [];
      lines.push(activeRenderTheme.dim("Select a user message to fork from (newest last):"));
      lines.push("");
      lines.push(...this.list.render(Math.max(1, width - 4)));
      return overlayPanel("Fork from User Message", lines, width);
    });
  }
}

export function openForkSelector(
  state: MixCodeState,
  sessionId: string,
  runtime: MixCodeKeyRuntime,
  tui: OverlayTui,
): void {
  const items = runtime.getForkableUserMessages(sessionId);
  if (items.length === 0) {
    const tab = state.tabs.find((t) => t.sessionId === sessionId);
    if (tab) {
      tab.toast = { type: "warning", message: "No forkable user messages", createdAt: Date.now() };
    }
    tui.requestRender();
    return;
  }

  const component = new ForkSelector(items, () => themeForId(state.theme), {
    onSelect: (entryId) => {
      closeAppOverlay(tui);
      // Fork is async; don't await here, the fork logic handles the tab switch and editor refill
      void runtime.extensionFork(sessionId, entryId);
    },
    onCancel: () => closeAppOverlay(tui),
  });
  showComponentOverlay(tui, component);
  tui.requestRender();
}
