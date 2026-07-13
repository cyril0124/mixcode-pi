import type { Component } from "@earendil-works/pi-tui";
import {
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface LoopViewEntry {
  id: string;
  name: string;
  prompt: string;
  intervalLabel: string;
  createdAt: Date;
  fireCount: number;
  nextRunAt: number;
}

interface LoopManagementActions {
  getLoops: () => LoopViewEntry[];
  fire: (prompt: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

type ConfirmState = { kind: "remove"; id: string; name: string } | { kind: "cleanup" };

export class LoopManagementView implements Component {
  private loops: LoopViewEntry[];
  private query = "";
  private selectedIndex = 0;
  private mode: "list" | "detail" = "list";
  private detailLoopId: string | null = null;
  private promptScrollOffset = 0;
  private detailPromptLineCount = 0;
  private detailPromptRows = 1;
  private confirm: ConfirmState | null = null;

  constructor(
    private theme: any,
    private requestRender: () => void,
    private done: () => void,
    private getMaxVisibleRows: () => number,
    private actions: LoopManagementActions,
  ) {
    this.loops = actions.getLoops();
  }

  invalidate(): void {}

  private filteredLoops(): LoopViewEntry[] {
    return fuzzyFilter(
      this.loops,
      this.query,
      (loop) => `${loop.id} ${loop.name} ${loop.intervalLabel} ${loop.prompt}`,
    );
  }

  private selectedLoop(): LoopViewEntry | undefined {
    return this.filteredLoops()[this.selectedIndex];
  }

  private refresh(): void {
    this.loops = this.actions.getLoops();
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredLoops().length - 1),
    );
    this.requestRender();
  }

  private moveSelection(delta: number): void {
    const count = this.filteredLoops().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.confirm) {
      this.handleConfirmInput(data);
      return;
    }
    if (this.mode === "detail") {
      this.handleDetailInput(data);
      return;
    }
    this.handleNormalInput(data);
  }

  private handleConfirmInput(data: string): void {
    const confirm = this.confirm;
    if (!confirm) return;

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "y")) {
      if (confirm.kind === "remove") this.actions.remove(confirm.id);
      else this.actions.clear();
      this.confirm = null;
      this.refresh();
      return;
    }
    if (matchesKey(data, "n")) {
      this.confirm = null;
      this.requestRender();
    }
  }

  private handleNormalInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "enter")) {
      const loop = this.selectedLoop();
      if (loop) {
        this.mode = "detail";
        this.detailLoopId = loop.id;
        this.promptScrollOffset = 0;
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "f")) {
      const loop = this.selectedLoop();
      if (loop) {
        this.actions.fire(loop.prompt);
        this.done();
      }
      return;
    }
    if (matchesKey(data, "x")) {
      const loop = this.selectedLoop();
      if (loop) {
        this.confirm = { kind: "remove", id: loop.id, name: loop.name };
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "c")) {
      if (this.loops.length > 0) {
        this.confirm = { kind: "cleanup" };
        this.requestRender();
      }
      return;
    }
    if (data === "\u007f" || matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.selectedIndex = 0;
      this.requestRender();
      return;
    }
    if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
      this.query += data;
      this.selectedIndex = 0;
      this.requestRender();
    }
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "left")) {
      this.mode = "list";
      this.requestRender();
      return;
    }
    if (matchesKey(data, "f")) {
      const loop = this.loops.find((entry) => entry.id === this.detailLoopId);
      if (loop) {
        this.actions.fire(loop.prompt);
        this.done();
      }
      return;
    }
    if (matchesKey(data, "x")) {
      const loop = this.loops.find((entry) => entry.id === this.detailLoopId);
      if (loop) {
        this.confirm = { kind: "remove", id: loop.id, name: loop.name };
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollPrompt(1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollPrompt(-1);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollPrompt(this.detailPromptRows);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollPrompt(-this.detailPromptRows);
      return;
    }
    if (matchesKey(data, "home")) {
      this.promptScrollOffset = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.promptScrollOffset = Math.max(0, this.detailPromptLineCount - this.detailPromptRows);
      this.requestRender();
    }
  }

  private scrollPrompt(delta: number): void {
    const maxOffset = Math.max(0, this.detailPromptLineCount - this.detailPromptRows);
    this.promptScrollOffset = Math.min(maxOffset, Math.max(0, this.promptScrollOffset + delta));
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.confirm?.kind === "remove") {
      return this.renderPanel(
        [
          this.theme.fg("warning", ` Remove loop "${this.confirm.name}"?`),
          "",
          this.theme.fg("dim", "  y confirm  n cancel"),
        ],
        width,
      );
    }
    if (this.confirm?.kind === "cleanup") {
      return this.renderPanel(
        [
          this.theme.fg("warning", ` Remove all ${this.loops.length} loops?`),
          "",
          this.theme.fg("dim", "  y confirm  n cancel"),
        ],
        width,
      );
    }

    const innerWidth = Math.max(1, width - 2);
    if (this.mode === "detail") return this.renderDetail(innerWidth, width);
    return this.renderPanel(
      [
        ` ${this.theme.fg("accent", ">")} ${this.query || " "}`,
        this.theme.fg("border", "─".repeat(innerWidth)),
        ...this.renderRows(innerWidth),
        "",
        this.theme.fg("dim", "  ↑↓ select  ⏎ view  f fire  x remove  c clear  esc close"),
      ],
      width,
    );
  }

  private renderDetail(innerWidth: number, width: number): string[] {
    const loop = this.loops.find((entry) => entry.id === this.detailLoopId);
    if (!loop) {
      this.mode = "list";
      return this.render(width);
    }

    const promptWidth = Math.max(1, innerWidth - 2);
    const wrappedPrompt = wrapTextWithAnsi(loop.prompt, promptWidth);
    const promptLines = wrappedPrompt.length > 0 ? wrappedPrompt : [""];
    const promptRows = Math.max(1, this.getMaxVisibleRows() - 3);
    const maxOffset = Math.max(0, promptLines.length - promptRows);
    this.promptScrollOffset = Math.min(this.promptScrollOffset, maxOffset);
    this.detailPromptLineCount = promptLines.length;
    this.detailPromptRows = promptRows;
    const visiblePrompt = promptLines.slice(
      this.promptScrollOffset,
      this.promptScrollOffset + promptRows,
    );
    const rangeStart = this.promptScrollOffset + 1;
    const rangeEnd = this.promptScrollOffset + visiblePrompt.length;
    return this.renderPanel(
      [
        ` Name: ${loop.name}`,
        ` Interval: ${loop.intervalLabel}  Next: ${formatRelativeTime(loop.nextRunAt)}  Runs: ${loop.fireCount}`,
        this.theme.fg("border", "─".repeat(innerWidth)),
        ` ${this.theme.fg("accent", "Prompt")}  ${this.theme.fg("dim", `Lines ${rangeStart}-${rangeEnd}/${promptLines.length}`)}`,
        ...visiblePrompt.map((line) => `  ${line}`),
        "",
        this.theme.fg("dim", "  ↑↓ scroll  PgUp/PgDn page  Home/End jump"),
        this.theme.fg("dim", "  f fire  x remove  ←/esc back"),
      ],
      width,
      `Loop ${loop.id}`,
    );
  }

  private renderRows(width: number): string[] {
    const loops = this.filteredLoops();
    if (loops.length === 0) return [this.theme.fg("dim", "  No matching loops")];

    const remaining = Math.max(0, width - 6);
    const nameWidth = Math.max(8, Math.floor(remaining * 0.32));
    const intervalWidth = Math.max(6, Math.floor(remaining * 0.16));
    const detailWidth = Math.max(8, remaining - nameWidth - intervalWidth);
    const maxVisible = Math.min(15, Math.max(1, this.getMaxVisibleRows()));
    const start = Math.min(
      Math.max(0, this.selectedIndex - maxVisible + 1),
      Math.max(0, loops.length - maxVisible),
    );

    return loops.slice(start, start + maxVisible).map((loop, visibleIndex) => {
      const selected = start + visibleIndex === this.selectedIndex;
      const marker = selected ? "› " : "  ";
      const name = truncateToWidth(`${loop.id}  ${loop.name}`, nameWidth, "…");
      const interval = truncateToWidth(loop.intervalLabel, intervalWidth, "…");
      const detail = truncateToWidth(
        `${loop.prompt}  ·  ${formatRelativeTime(loop.nextRunAt)}  ·  ${loop.fireCount} fires`,
        detailWidth,
        "…",
      );
      const row = `${marker}${this.pad(name, nameWidth)}  ${this.pad(interval, intervalWidth)}  ${this.theme.fg("dim", detail)}`;
      const padded = this.pad(row, width);
      return selected ? this.theme.bg("selectedBg", padded) : padded;
    });
  }

  private renderPanel(lines: string[], width: number, panelTitle = "Loops"): string[] {
    const innerWidth = Math.max(0, width - 2);
    const title = ` ${panelTitle} `;
    const top = `${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}`;
    const border = (text: string) => this.theme.fg("border", text);
    return [
      `${border("┌")}${border(this.pad(top, innerWidth))}${border("┐")}`,
      ...lines.map((line) => `${border("│")}${this.pad(line, innerWidth)}${border("│")}`),
      `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
    ];
  }

  private pad(text: string, width: number): string {
    const singleLine = text.replace(/[\r\n]+/g, " ");
    const clipped = visibleWidth(singleLine) <= width
      ? singleLine
      : truncateToWidth(singleLine, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }
}

function formatRelativeTime(date: Date | number): string {
  const target = typeof date === "number" ? date : date.getTime();
  const diff = target - Date.now();
  const seconds = Math.floor(Math.abs(diff) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const value = days > 0 ? `${days}d` : hours > 0 ? `${hours}h` : minutes > 0 ? `${minutes}m` : `${seconds}s`;
  return diff > 0 ? `in ${value}` : `${value} ago`;
}
