import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatRelativeTime, LoopInputError, parseMaxRuns } from "./loop-helpers.js";

/** Theme surface used by the loop management overlay. */
type LoopTheme = Pick<Theme, "fg" | "bg">;

export type LoopConflictMode = "skip" | "defer";

export interface LoopViewEntry {
  id: string;
  name: string;
  prompt: string;
  intervalLabel: string;
  fireCount: number;
  maxFireCount: number | null;
  nextRunAt: number;
  mode: LoopConflictMode;
  pending: boolean;
}

interface LoopManagementActions {
  getLoops: () => LoopViewEntry[];
  fire: (prompt: string) => void;
  setMode: (id: string, mode: LoopConflictMode) => void;
  setMaxFireCount: (id: string, maxFireCount: number | null) => void;
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
  private countInput: Input | null = null;
  private countInputError: string | null = null;
  private confirm: ConfirmState | null = null;

  constructor(
    private theme: LoopTheme,
    private requestRender: () => void,
    private done: () => void,
    /** Total panel rows, including borders, metadata and footer. */
    private getMaxHeight: () => number,
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
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredLoops().length - 1));
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
    this.confirm = null;
    if (matchesKey(data, "y")) {
      if (confirm.kind === "remove") this.actions.remove(confirm.id);
      else this.actions.clear();
      this.refresh();
      return;
    }
    // Every other key cancels without falling through to search or another action.
    this.requestRender();
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
    if (matchesKey(data, "ctrl+u")) {
      this.query = "";
      this.selectedIndex = 0;
      this.requestRender();
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
    if (this.countInput) {
      this.countInput.handleInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "left")) {
      this.mode = "list";
      this.requestRender();
      return;
    }
    if (matchesKey(data, "c")) {
      const loop = this.loops.find((entry) => entry.id === this.detailLoopId);
      if (loop) this.beginCountEdit(loop);
      return;
    }
    if (matchesKey(data, "m")) {
      const loop = this.loops.find((entry) => entry.id === this.detailLoopId);
      if (loop) {
        const nextMode = loop.mode === "defer" ? "skip" : "defer";
        this.actions.setMode(loop.id, nextMode);
        this.refresh();
      }
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
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollPrompt(1);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
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
    if (matchesKey(data, "ctrl+d")) {
      this.scrollPrompt(Math.max(1, Math.floor(this.detailPromptRows / 2)));
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.scrollPrompt(-Math.max(1, Math.floor(this.detailPromptRows / 2)));
      return;
    }
    if (matchesKey(data, "home") || data === "g") {
      this.promptScrollOffset = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "end") || data === "G") {
      this.promptScrollOffset = Math.max(0, this.detailPromptLineCount - this.detailPromptRows);
      this.requestRender();
    }
  }

  private beginCountEdit(loop: LoopViewEntry): void {
    const input = new Input();
    input.focused = true;
    input.onEscape = () => {
      this.countInput = null;
      this.countInputError = null;
    };
    input.onSubmit = (value) => {
      let maxFireCount: number | null;
      try {
        maxFireCount = parseMaxRuns(value.trim() || "unlimited", loop.fireCount);
      } catch (error) {
        if (!(error instanceof LoopInputError)) throw error;
        this.countInputError = error.message;
        return;
      }
      this.actions.setMaxFireCount(loop.id, maxFireCount);
      this.countInput = null;
      this.countInputError = null;
      this.refresh();
    };
    this.countInput = input;
    this.countInputError = null;
    this.requestRender();
  }

  private scrollPrompt(delta: number): void {
    const maxOffset = Math.max(0, this.detailPromptLineCount - this.detailPromptRows);
    this.promptScrollOffset = Math.min(maxOffset, Math.max(0, this.promptScrollOffset + delta));
    this.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    if (this.mode === "detail") return this.renderDetail(innerWidth, width);
    const footer = this.renderFooter(innerWidth, false);
    const bodyRows = this.availableBodyRows(footer.length);
    const header =
      bodyRows >= 4
        ? [this.theme.fg("dim", ` Search: ${this.query || "_"}`), this.separator(innerWidth)]
        : [];
    return this.renderPanel(
      [...header, ...this.renderRows(innerWidth, bodyRows - header.length)],
      footer,
      width,
      `Loops (${this.loops.length})`,
    );
  }

  private renderDetail(innerWidth: number, width: number): string[] {
    const loop = this.loops.find((entry) => entry.id === this.detailLoopId);
    if (!loop) {
      this.mode = "list";
      return this.render(width);
    }
    if (this.countInput) {
      const current = loop.maxFireCount === null ? "unlimited" : String(loop.maxFireCount);
      const errorLines = this.countInputError
        ? wrapTextWithAnsi(this.countInputError, Math.max(1, innerWidth - 2)).map((line) =>
            this.theme.fg("error", ` ${line}`),
          )
        : [];
      return this.renderPanel(
        [
          ` Executed: ${loop.fireCount}  Current total: ${current}`,
          " Total runs (blank = unlimited):",
          ...this.countInput.render(Math.max(1, innerWidth - 2)).map((line) => ` ${line}`),
          ...errorLines,
        ],
        [this.fitHints(innerWidth, "Enter save", [], "esc cancel", "Enter  esc")],
        width,
        `Loop ${loop.id} - Count`,
      );
    }
    const footer = this.renderFooter(innerWidth, true);
    const bodyRows = this.availableBodyRows(footer.length);
    const next = this.theme.fg(loop.pending ? "warning" : "accent", this.nextLabel(loop));
    // Drop secondary metadata on short terminals before sacrificing prompt rows.
    const metadata = [
      ` Next: ${next}  Runs: ${this.runCount(loop)}`,
      this.theme.fg("dim", ` Interval: ${loop.intervalLabel}  When busy: ${loop.mode}`),
    ].slice(0, Math.max(0, bodyRows - 4));
    const promptBoxWidth = Math.max(4, innerWidth - 2);
    const promptContentWidth = Math.max(1, promptBoxWidth - 4);
    const wrapped = wrapTextWithAnsi(loop.prompt, promptContentWidth);
    const promptLines = wrapped.length > 0 ? wrapped : [""];
    const promptRows = Math.max(
      1,
      bodyRows - metadata.length - (bodyRows - metadata.length >= 5 ? 3 : 2),
    );
    this.promptScrollOffset = Math.min(
      this.promptScrollOffset,
      Math.max(0, promptLines.length - promptRows),
    );
    this.detailPromptLineCount = promptLines.length;
    this.detailPromptRows = promptRows;
    const visiblePrompt = promptLines.slice(
      this.promptScrollOffset,
      this.promptScrollOffset + promptRows,
    );
    const range = `${this.promptScrollOffset + 1}-${this.promptScrollOffset + visiblePrompt.length}/${promptLines.length}`;
    return this.renderPanel(
      [
        ...metadata,
        ...(bodyRows - metadata.length >= 3 ? [""] : []),
        `  ┌─ Prompt ${this.theme.fg("dim", `Lines ${range}`)} ${"─".repeat(Math.max(0, promptBoxWidth - visibleWidth(`  ┌─ Prompt Lines ${range} `) - 1))}┐`,
        ...(bodyRows - metadata.length >= 5 ? [""] : []),
        ...visiblePrompt.map((line) => `  │ ${line} │`),
        `  └${"─".repeat(Math.max(0, promptBoxWidth - 2))}┘`,
      ],
      footer,
      width,
      `Loop ${loop.id}`,
    );
  }

  private renderRows(width: number, rowBudget: number): string[] {
    const loops = this.filteredLoops();
    if (loops.length === 0) return [this.theme.fg("dim", " No matching loops")];
    // Each selection is one complete two-line item; never clip its second row.
    const maxVisible = Math.min(15, Math.max(0, Math.floor(rowBudget / (rowBudget >= 6 ? 3 : 2))));
    if (maxVisible === 0) return [];
    const start = Math.min(
      Math.max(0, this.selectedIndex - maxVisible + 1),
      Math.max(0, loops.length - maxVisible),
    );
    return loops.slice(start, start + maxVisible).flatMap((loop, index) => {
      const selected = start + index === this.selectedIndex;
      const nextLabel = this.nextLabel(loop);
      const rowWidth = Math.max(0, width - 1);
      const nextWidth = Math.min(visibleWidth(nextLabel), rowWidth);
      const summaryWidth = Math.max(0, rowWidth - nextWidth - 1);
      const summary = `${selected ? "› " : "  "}#${loop.id} ${truncateToWidth(loop.prompt.replace(/[\r\n]+/g, " "), 24, "…")}`;
      const next = this.theme.fg(
        loop.pending ? "warning" : "accent",
        this.pad(nextLabel, nextWidth),
      );
      const top = summaryWidth > 0 ? `${this.pad(summary, summaryWidth)} ${next}` : next;
      const runs = `Runs: ${this.runCount(loop)}`;
      const interval = `Every ${loop.intervalLabel}`;
      const mode = `When busy: ${loop.mode}`;
      let metadata = `${interval}  ${runs}  ${mode}`;
      const metadataWidth = Math.max(0, width - 4);
      if (visibleWidth(metadata) > metadataWidth) metadata = `${interval}  ${runs}`;
      if (visibleWidth(metadata) > metadataWidth) metadata = runs;
      if (visibleWidth(metadata) > metadataWidth) {
        metadata = loop.maxFireCount === null ? `${loop.fireCount} runs` : this.runCount(loop);
      }
      const bottom = this.theme.fg("dim", `    ${metadata}`);
      const renderedRows = [top, bottom].map((line) => {
        const padded = this.pad(line, width);
        return selected ? this.theme.bg("selectedBg", padded) : padded;
      });
      if (index < maxVisible - 1 && rowBudget >= maxVisible * 3)
        renderedRows.push(this.pad("", width));
      return renderedRows;
    });
  }

  private nextLabel(loop: LoopViewEntry): string {
    return loop.pending ? "waiting" : formatRelativeTime(loop.nextRunAt);
  }

  private runCount(loop: LoopViewEntry): string {
    return loop.maxFireCount === null
      ? `${loop.fireCount}/unlimited`
      : `${loop.fireCount}/${loop.maxFireCount}`;
  }

  private renderFooter(width: number, detail: boolean): string[] {
    if (this.confirm) {
      const question =
        this.confirm.kind === "remove"
          ? `Remove loop "${this.confirm.name}"?`
          : `Remove all ${this.loops.length} loops?`;
      return [
        this.theme.fg("warning", this.pad(` ${question}`, width)),
        this.theme.fg(
          "warning",
          this.pad(
            width >= 34 ? " y confirm  any other key cancels" : "y yes  other cancel",
            width,
          ),
        ),
      ];
    }
    if (!detail) {
      return [
        this.fitHints(
          width,
          "↑↓ select",
          ["Enter view", "f fire", "x remove", "c clear"],
          "q close",
          "↑↓  q close",
        ),
      ];
    }
    const navigation = this.fitHints(
      width,
      "↑↓/jk scroll",
      ["^D/U half", "g/G ends"],
      "q close",
      "↑↓/jk  q close",
    );
    if (this.getMaxHeight() < 10) return [navigation];
    return [
      "",
      navigation,
      this.fitHints(width, "c runs", ["m mode", "f fire", "x remove"], "←/esc back", "c  esc back"),
    ];
  }

  private fitHints(
    width: number,
    first: string,
    middle: string[],
    last: string,
    compact: string,
  ): string {
    const options = [...middle];
    const contentWidth = Math.max(0, width - 2);
    let text = [first, ...options, last].join("  ");
    while (visibleWidth(text) > contentWidth && options.length > 0) {
      options.pop();
      text = [first, ...options, last].join("  ");
    }
    if (visibleWidth(text) > contentWidth) text = compact;
    return this.theme.fg("dim", this.pad(` ${text}`, width));
  }

  private availableBodyRows(footerRows: number): number {
    return Math.max(0, Math.floor(this.getMaxHeight()) - 2 - footerRows);
  }

  private separator(width: number): string {
    return this.theme.fg("border", "─".repeat(Math.max(0, width)));
  }

  private renderPanel(
    body: string[],
    footer: string[],
    width: number,
    panelTitle: string,
  ): string[] {
    const maxHeight = Math.max(0, Math.floor(this.getMaxHeight()));
    if (width <= 0 || maxHeight === 0) return [];
    if (width < 2 || maxHeight < 3) {
      return [...body, ...footer].slice(-maxHeight).map((line) => this.pad(line, width));
    }
    const innerWidth = width - 2;
    const footerRows = Math.min(footer.length, maxHeight - 2);
    const lines = [...body.slice(0, maxHeight - 2 - footerRows), ...footer.slice(-footerRows)];
    const title = ` ${panelTitle} `;
    const top = `${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}`;
    const border = (text: string) => this.theme.fg("border", text);
    return [
      `${border("┌")}${border(this.pad(top, innerWidth))}${border("┐")}`,
      ...lines.map((line) => `${border("│")}${this.pad(line, innerWidth)}${border("│")}`),
      `${border("└")}${this.separator(innerWidth)}${border("┘")}`,
    ];
  }

  private pad(text: string, width: number): string {
    const singleLine = text.replace(/[\r\n]+/g, " ");
    const clipped =
      visibleWidth(singleLine) <= width ? singleLine : truncateToWidth(singleLine, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }
}
