/**
 * mpi-cron: the `/cron` management overlay.
 *
 * Keyboard-first, in the shape of the other MixCode management views: arrows and
 * j/k move, Enter opens a job, n starts the create wizard, space pauses or
 * resumes, d removes, f fires now, c cleans up finished jobs. Destructive keys
 * ask for `y` first.
 */

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
import {
  CronParseError,
  describeSchedule,
  formatRunCount,
  formatSince,
  formatUntil,
  parseSchedule,
} from "./cron-engine.js";
import { sortJobs, statusGlyph } from "./cron-widget.js";
import type { CronJob, CronJobInput } from "./types.js";

type CronTheme = Pick<Theme, "fg" | "bg">;

export interface CronViewActions {
  /** Current job list; re-read on every refresh so the view never goes stale. */
  getJobs: () => CronJob[];
  /** Create a new job. */
  add: (input: CronJobInput) => Promise<CronJob> | CronJob;
  /** Resume or pause a job. */
  setEnabled: (id: string, enabled: boolean) => Promise<void> | void;
  /** Fire a job now, still honouring the store claim. */
  fireNow: (id: string) => Promise<void> | void;
  remove: (id: string) => Promise<void> | void;
  /** Delete jobs whose run is finished. */
  cleanup: () => Promise<number> | number;
}

type ConfirmState = { kind: "remove"; id: string; name: string } | { kind: "cleanup" };

/** Steps in the inline job-creation flow. */
type AddStep = "schedule" | "prompt" | "name";

interface AddState {
  step: AddStep;
  input: Input;
  /** Accumulated fields. */
  schedule?: string;
  prompt?: string;
  /** Error shown below the input on a validation failure. */
  error: string | null;
}

export class CronManagementView implements Component {
  private jobs: CronJob[];
  private query = "";
  private selectedIndex = 0;
  private mode: "list" | "detail" = "list";
  private detailJobId: string | null = null;
  private promptScrollOffset = 0;
  private detailPromptLineCount = 0;
  private detailPromptRows = 1;
  private confirm: ConfirmState | null = null;
  private adding: AddState | null = null;
  private status: string | null = null;
  private busy = false;

  constructor(
    private theme: CronTheme,
    private requestRender: () => void,
    private done: () => void,
    /** Total panel rows available, including borders and footer. */
    private getMaxHeight: () => number,
    private actions: CronViewActions,
  ) {
    this.jobs = sortJobs(actions.getJobs());
  }

  invalidate(): void {}

  private filteredJobs(): CronJob[] {
    return fuzzyFilter(
      this.jobs,
      this.query,
      (job) => `${job.name} ${job.id} ${job.prompt} ${describeSchedule(job.schedule)}`,
    );
  }

  private selectedJob(): CronJob | undefined {
    return this.filteredJobs()[this.selectedIndex];
  }

  private detailJob(): CronJob | undefined {
    return this.jobs.find((job) => job.id === this.detailJobId);
  }

  private refresh(): void {
    this.jobs = sortJobs(this.actions.getJobs());
    const count = this.filteredJobs().length;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, count - 1));
    this.requestRender();
  }

  private moveSelection(delta: number): void {
    const count = this.filteredJobs().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.requestRender();
  }

  /** Run an action that awaits the store, then re-read and repaint. */
  private async run(action: () => Promise<void> | void, busy: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = busy;
    this.requestRender();
    try {
      await action();
      this.status = null;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  handleInput(data: string): void {
    if (this.adding) {
      this.handleAddInput(data);
      return;
    }
    if (this.confirm) {
      this.handleConfirmInput(data);
      return;
    }
    if (this.mode === "detail") {
      this.handleDetailInput(data);
      return;
    }
    this.handleListInput(data);
  }

  private beginAdd(): void {
    const input = new Input({
      prompt: "›  ",
      placeholder: "e.g.  0 9 * * *   every 5m   +30s   2026-10-01T09:00",
    });
    input.focused = true;
    input.onEscape = () => {
      this.adding = null;
      this.requestRender();
    };
    input.onSubmit = (value) => this.advanceAdd(value.trim());
    this.adding = { step: "schedule", input, error: null };
    this.requestRender();
  }

  private advanceAdd(value: string): void {
    const state = this.adding;
    if (!state) return;

    if (state.step === "schedule") {
      if (!value) return;
      try {
        parseSchedule(value, Date.now());
      } catch (error) {
        state.error = error instanceof CronParseError ? error.message : String(error);
        this.requestRender();
        return;
      }
      state.schedule = value;
      state.error = null;
      state.step = "prompt";
      state.input = new Input({
        prompt: "›  ",
        placeholder: "Text sent as a user message when the job fires.",
      });
      state.input.focused = true;
      state.input.onEscape = () => {
        // Go back to schedule step.
        this.beginAdd();
      };
      state.input.onSubmit = (v) => this.advanceAdd(v.trim());
      this.requestRender();
      return;
    }

    if (state.step === "prompt") {
      if (!value) return;
      state.prompt = value;
      state.error = null;
      state.step = "name";
      state.input = new Input({
        prompt: "›  ",
        placeholder: "optional, blank uses the first words of the prompt",
      });
      state.input.focused = true;
      state.input.onEscape = () => {
        // Go back to prompt step.
        if (state.schedule) {
          state.step = "prompt";
          state.input = new Input({
            prompt: "›  ",
            placeholder: "Text sent as a user message when the job fires.",
          });
          state.input.focused = true;
          state.input.onEscape = () => this.beginAdd();
          state.input.onSubmit = (v) => this.advanceAdd(v.trim());
        }
        this.requestRender();
      };
      state.input.onSubmit = (v) => this.advanceAdd(v.trim());
      this.requestRender();
      return;
    }

    if (state.step === "name") {
      // Name is optional: blank triggers auto-naming from hub.add.
      const name = value || undefined;
      const input: CronJobInput = {
        name,
        schedule: parseSchedule(state.schedule!, Date.now()),
        prompt: state.prompt!,
      };
      this.adding = null;
      void this.run(async () => {
        await this.actions.add(input);
      }, "Creating job…");
    }
  }

  private handleAddInput(data: string): void {
    const state = this.adding;
    if (!state) return;
    state.input.handleInput(data);
    this.requestRender();
  }

  private handleConfirmInput(data: string): void {
    const confirm = this.confirm;
    if (!confirm) return;
    this.confirm = null;
    if (!matchesKey(data, "y")) {
      // Every other key cancels; destructive keys must never fall through to
      // the list bindings (pressing "d" twice must not delete without a "y").
      this.requestRender();
      return;
    }
    if (confirm.kind === "remove") {
      void this.run(() => this.actions.remove(confirm.id), `Removing ${confirm.name}…`);
    } else {
      void this.run(async () => {
        const removed = await this.actions.cleanup();
        this.status = removed === 0 ? "Nothing to clean up." : `Removed ${removed} job(s).`;
      }, "Cleaning up…");
    }
  }

  private handleListInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j") || matchesKey(data, "tab")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k") || matchesKey(data, "shift+tab")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "enter")) {
      const job = this.selectedJob();
      if (job) {
        this.mode = "detail";
        this.detailJobId = job.id;
        this.promptScrollOffset = 0;
        this.status = null;
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "space")) {
      const job = this.selectedJob();
      if (job) {
        void this.run(
          () => this.actions.setEnabled(job.id, !job.enabled),
          job.enabled ? `Pausing ${job.name}…` : `Resuming ${job.name}…`,
        );
      }
      return;
    }
    if (matchesKey(data, "f")) {
      const job = this.selectedJob();
      if (job) void this.run(() => this.actions.fireNow(job.id), `Firing ${job.name}…`);
      return;
    }
    if (matchesKey(data, "d")) {
      const job = this.selectedJob();
      if (job) {
        this.confirm = { kind: "remove", id: job.id, name: job.name };
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "n")) {
      this.beginAdd();
      return;
    }
    if (matchesKey(data, "c")) {
      if (this.jobs.some((job) => !job.enabled)) {
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
    if (matchesKey(data, "backspace") || data === "\u007f") {
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
    if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "q")) {
      this.mode = "list";
      this.status = null;
      this.requestRender();
      return;
    }
    const job = this.detailJob();
    if (matchesKey(data, "space")) {
      if (job) {
        void this.run(
          () => this.actions.setEnabled(job.id, !job.enabled),
          job.enabled ? `Pausing ${job.name}…` : `Resuming ${job.name}…`,
        );
      }
      return;
    }
    if (matchesKey(data, "f")) {
      if (job) void this.run(() => this.actions.fireNow(job.id), `Firing ${job.name}…`);
      return;
    }
    if (matchesKey(data, "d")) {
      if (job) {
        this.confirm = { kind: "remove", id: job.id, name: job.name };
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

  private scrollPrompt(delta: number): void {
    const maxOffset = Math.max(0, this.detailPromptLineCount - this.detailPromptRows);
    this.promptScrollOffset = Math.min(maxOffset, Math.max(0, this.promptScrollOffset + delta));
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.adding) return this.renderAdd(width);
    if (this.mode === "detail") return this.renderDetail(width);
    // Every inner helper pads to the panel's inner width: padding to the outer
    // width would make the panel itself clip the line and append an ellipsis.
    const innerWidth = headerWidth(width);
    const footer = this.renderFooter(innerWidth, false);
    const bodyRows = this.availableBodyRows(footer.length);
    const header = bodyRows >= 4 ? this.renderSearch(innerWidth) : [];
    const body = this.renderRows(innerWidth, Math.max(0, bodyRows - header.length));
    return this.renderPanel([...header, ...body], footer, width, `Cron jobs (${this.jobs.length})`);
  }

  private renderSearch(width: number): string[] {
    return [
      this.theme.fg("dim", this.pad(` Filter: ${this.query || "_"}`, width)),
      this.separator(width),
    ];
  }

  private renderDetail(width: number): string[] {
    const job = this.detailJob();
    if (!job) {
      this.mode = "list";
      return this.render(width);
    }
    const innerWidth = Math.max(1, width - 2);
    const footer = this.renderFooter(innerWidth, true);
    const bodyRows = this.availableBodyRows(footer.length);
    const next =
      job.claim !== undefined
        ? "running now"
        : !job.enabled
          ? "paused"
          : job.nextRun !== undefined
            ? `${formatUntil(job.nextRun, Date.now())} (${new Date(job.nextRun).toLocaleString()})`
            : "finished";
    const metadata = [
      ` State: ${job.enabled ? "enabled" : "paused"}`,
      ` Schedule: ${describeSchedule(job.schedule)}`,
      ` Next: ${next}`,
      ` Runs: ${job.runCount}  Last: ${lastRunLabel(job, Date.now())}`,
      ...(job.description ? [` Notes: ${job.description}`] : []),
    ];
    const promptBoxWidth = Math.max(4, innerWidth - 2);
    const promptContentWidth = Math.max(1, promptBoxWidth - 4);
    const wrapped = wrapTextWithAnsi(job.prompt, promptContentWidth);
    const promptLines = wrapped.length > 0 ? wrapped : [""];
    const capacity = Math.max(0, bodyRows - metadata.length - 2);
    const promptRows = Math.max(1, capacity);
    this.detailPromptLineCount = promptLines.length;
    this.detailPromptRows = promptRows;
    this.promptScrollOffset = Math.min(
      this.promptScrollOffset,
      Math.max(0, promptLines.length - promptRows),
    );
    const visible = promptLines.slice(
      this.promptScrollOffset,
      this.promptScrollOffset + promptRows,
    );
    const range = `${this.promptScrollOffset + 1}-${this.promptScrollOffset + visible.length}/${promptLines.length}`;
    const title = ` Prompt ${range} `;
    // The frame sits one column inside the panel borders: its corners plus an
    // edge of `promptBoxWidth - 2` columns fill the row exactly. Content rows
    // repeat the right edge so the box is closed on both sides.
    const frameInner = Math.max(0, promptBoxWidth - 2);
    const top = `${title}${"─".repeat(Math.max(0, frameInner - visibleWidth(title)))}`;
    return this.renderPanel(
      [
        ...metadata.slice(0, Math.max(0, bodyRows - 3)),
        this.theme.fg("border", ` ┌${top}┐ `),
        ...visible.map((line) => ` │ ${this.pad(line, promptContentWidth)} │ `),
        this.theme.fg("border", ` └${"─".repeat(frameInner)}┘ `),
      ],
      footer,
      width,
      job.name,
    );
  }

  private renderRows(width: number, rowBudget: number): string[] {
    const jobs = this.filteredJobs();
    if (jobs.length === 0) {
      return [
        this.theme.fg(
          "dim",
          this.pad(this.query ? " No matching jobs" : " No cron jobs yet", width),
        ),
      ];
    }
    const perItem = rowBudget >= jobs.length * 3 ? 2 : 1;
    const maxVisible = Math.max(1, Math.floor(rowBudget / (perItem + 1)));
    const start = Math.min(
      Math.max(0, this.selectedIndex - maxVisible + 1),
      Math.max(0, jobs.length - maxVisible),
    );
    const selectedBg = (line: string) => this.theme.bg("selectedBg", line);
    const rows: string[] = [];
    for (const [index, job] of jobs.slice(start, start + maxVisible).entries()) {
      const selected = start + index === this.selectedIndex;
      const { glyph, tone } = statusGlyph(job);
      const label = `${selected ? "›" : " "} ${glyph} ${job.name}`;
      const right =
        job.claim !== undefined
          ? "running"
          : job.enabled && job.nextRun !== undefined
            ? formatUntil(job.nextRun, Date.now())
            : job.enabled
              ? "—"
              : "paused";
      const labelWidth = Math.max(4, width - visibleWidth(right) - 2);
      const nameText = this.theme.fg(tone, truncateToWidth(label, labelWidth, "…"));
      const rightWidth = Math.max(0, width - labelWidth - 1);
      const rightText = this.theme.fg(job.enabled ? "accent" : "dim", this.pad(right, rightWidth));
      const top = `${nameText} ${rightText}`;
      rows.push(selected ? selectedBg(this.pad(top, width)) : this.pad(top, width));
      if (perItem === 2) {
        const last =
          job.lastRun !== undefined ? `last ${formatSince(job.lastRun, Date.now())}` : "never run";
        const meta = `    ${describeSchedule(job.schedule)}  ${formatRunCount(job.runCount)}  ${last}`;
        const line = this.theme.fg("dim", meta);
        rows.push(selected ? selectedBg(this.pad(line, width)) : this.pad(line, width));
        // Blank separator between jobs when there is enough vertical space.
        rows.push("");
      }
    }
    if (jobs.length > maxVisible) {
      rows.push(this.theme.fg("dim", this.pad(` … ${jobs.length - maxVisible} more`, width)));
    }
    return rows;
  }

  private renderAdd(width: number): string[] {
    const state = this.adding;
    if (!state) return this.render(width);
    const innerWidth = Math.max(1, width - 2);

    const steps: AddStep[] = ["schedule", "prompt", "name"];
    const stepIndex = steps.indexOf(state.step);
    const stepLabels: Record<AddStep, string> = {
      schedule: "Schedule",
      prompt: "Prompt",
      name: "Name",
    };
    // Completed fields shown above the separator.
    const done: string[] = [];
    if (state.step !== "schedule" && state.schedule)
      done.push(this.theme.fg("dim", ` ✓ schedule  ${state.schedule}`));
    if (state.step === "name" && state.prompt) {
      const preview = state.prompt.length > 48 ? `${state.prompt.slice(0, 48)}…` : state.prompt;
      done.push(this.theme.fg("dim", ` ✓ prompt    ${preview}`));
    }

    // Blank line above the content, plus a second blank line between the
    // completed fields and the active one.
    const topPad = [""];
    const sep = done.length > 0 ? [""] : [];

    // Active field: label only, hint lives in the Input placeholder.
    const labelLine = this.theme.fg("accent", ` ${stepLabels[state.step]}`);
    const inputLines = state.input.render(Math.max(1, innerWidth - 2)).map((line) => `  ${line}`);
    const errorLines = state.error
      ? wrapTextWithAnsi(state.error, Math.max(1, innerWidth - 4)).map((line) =>
          this.theme.fg("warning", `  ! ${line}`),
        )
      : [];

    const footer = [
      this.fitHints(
        innerWidth,
        "Enter confirm",
        stepIndex > 0 ? ["Esc back"] : [],
        "Ctrl+C cancel",
        "Enter  Esc  Ctrl+C",
      ),
    ];

    return this.renderPanel(
      [
        ...topPad,
        ...done,
        ...sep,
        labelLine,
        ...inputLines,
        ...(errorLines.length > 0 ? ["", ...errorLines] : []),
      ],
      footer,
      width,
      `New cron job (${stepIndex + 1}/3)`,
    );
  }

  private renderFooter(width: number, detail: boolean): string[] {
    if (this.status && !this.confirm) {
      return [this.theme.fg("dim", this.pad(` ${this.status}`, width))];
    }
    if (this.confirm) {
      const question =
        this.confirm.kind === "remove"
          ? `Remove cron job "${this.confirm.name}"?`
          : "Remove all finished jobs?";
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
          "↑↓/jk select",
          ["n add", "Enter view", "space pause", "f fire", "d remove", "c cleanup"],
          "q close",
          "n add  q close",
        ),
      ];
    }
    return [
      this.fitHints(
        width,
        "↑↓/jk scroll",
        ["^D/U half", "g/G ends", "space pause", "f fire", "d remove"],
        "esc back",
        "↑↓  esc back",
      ),
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

  private renderPanel(body: string[], footer: string[], width: number, title: string): string[] {
    const maxHeight = Math.max(0, Math.floor(this.getMaxHeight()));
    if (width <= 0 || maxHeight === 0) return [];
    if (width < 2 || maxHeight < 3) {
      return [...body, ...footer].slice(-maxHeight).map((line) => this.pad(line, width));
    }
    const innerWidth = width - 2;
    const footerRows = Math.min(footer.length, maxHeight - 2);
    const lines = [...body.slice(0, maxHeight - 2 - footerRows), ...footer.slice(-footerRows)];
    const heading = ` ${title} `;
    const top = `${heading}${"─".repeat(Math.max(0, innerWidth - visibleWidth(heading)))}`;
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

/** Column width for headers that live inside the panel border. */
function headerWidth(width: number): number {
  return Math.max(0, width - 2);
}

/**
 * Detail-view last-run summary: outcome, age, and the absolute time. The age
 * shows whether the schedule is still being honoured; the stamp is for precision.
 */
function lastRunLabel(job: CronJob, now: number): string {
  if (job.lastRun === undefined) return "never";
  const status = job.lastStatus ?? "unknown";
  return `${status}, ${formatSince(job.lastRun, now)} (${new Date(job.lastRun).toLocaleString()})`;
}
