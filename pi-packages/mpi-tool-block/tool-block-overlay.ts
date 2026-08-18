import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildToolBlockRows,
  filterToolBlockRows,
  isToolBlockEnabled,
  toggleToolBlockRow,
  toolBlockRowState,
  type ToolBlockConfig,
  type ToolBlockLayer,
  type ToolBlockRow,
  type ToolRef,
} from "./tool-block-core.js";

export type ThemeLike = {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
};

export interface ToolBlockOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: () => void;
  tools: readonly ToolRef[];
  initial: ToolBlockConfig;
  session?: ToolBlockConfig | null;
  initialLayer?: ToolBlockLayer;
  configPath: string;
  persist: (
    config: ToolBlockConfig,
    layer: ToolBlockLayer,
  ) => { ok: true; config: ToolBlockConfig } | { ok: false; error: string };
  getActiveNames: () => readonly string[];
  onError?: (message: string) => void;
  getMaxVisible?: () => number;
}

export function createToolBlockOverlay(options: ToolBlockOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done, tools } = options;
  let layer: ToolBlockLayer = options.initialLayer === "session" && options.session ? "session" : "global";
  let globalDraft = options.initial;
  let sessionDraft: ToolBlockConfig | null = options.session ?? null;
  let draft = layer === "session" && sessionDraft ? sessionDraft : globalDraft;
  let query = "";
  let selected = 0;

  function rows(): ToolBlockRow[] {
    return filterToolBlockRows(buildToolBlockRows(tools, draft, options.getActiveNames()), query);
  }

  function selectable(
    list: ToolBlockRow[],
  ): Extract<ToolBlockRow, { kind: "layer" | "enabled" | "tool" }>[] {
    return list.filter(
      (row): row is Extract<ToolBlockRow, { kind: "layer" | "enabled" | "tool" }> => row.kind !== "header",
    );
  }

  function remember(next: ToolBlockConfig, target: ToolBlockLayer): void {
    draft = next;
    if (target === "session") sessionDraft = next;
    else globalDraft = next;
  }

  function snapshotConfig(config: ToolBlockConfig): ToolBlockConfig {
    return { enabled: config.enabled, hidden: config.hidden.map((item) => ({ ...item })) };
  }

  function clampSelected(): void {
    const count = selectable(rows()).length;
    selected = count === 0 ? 0 : Math.min(Math.max(0, selected), count - 1);
  }

  function handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (query.length > 0) {
        query = "";
        selected = 0;
        requestRender();
        return;
      }
      done();
      return;
    }
    if (matchesKey(data, Key.enter) || data === " ") {
      const current = selectable(rows())[selected];
      if (!current) return;
      if (current.kind === "layer") {
        const nextLayer: ToolBlockLayer = layer === "global" ? "session" : "global";
        if (nextLayer === "session" && !sessionDraft) {
          const written = options.persist(snapshotConfig(globalDraft), "session");
          if (!written.ok) {
            options.onError?.(written.error);
            return;
          }
          remember(written.config, "session");
        }
        layer = nextLayer;
        draft = layer === "session" && sessionDraft ? sessionDraft : globalDraft;
        requestRender();
        return;
      }
      const next = toggleToolBlockRow(draft, tools, current);
      const written = options.persist(next, layer);
      if (!written.ok) {
        options.onError?.(written.error);
        return;
      }
      remember(written.config, layer);
      requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      clampSelected();
      selected = Math.max(0, selected - 1);
      requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      clampSelected();
      selected = Math.min(selectable(rows()).length - 1, selected + 1);
      requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (query.length > 0) {
        query = query.slice(0, -1);
        selected = 0;
        requestRender();
      }
      return;
    }
    if (data.length > 0 && data.charCodeAt(0) >= 0x20 && data !== "\x7f") {
      query += data;
      selected = 0;
      requestRender();
    }
  }

  return {
    invalidate() {},
    handleInput,
    render(width: number) {
      clampSelected();
      const list = rows();
      const picks = selectable(list);
      const enabled = isToolBlockEnabled(draft);
      const bodyBudget = Math.max(6, options.getMaxVisible?.() ?? 12);
      const inner = Math.max(1, width - 2);
      const clip = (text: string) => truncateToWidth(text, inner, "…");
      const dim = (text: string) => theme.fg("dim", text);
      const accent = (text: string) => theme.fg("accent", text);

      const filterLine = clip(
        query
          ? `  ${dim("filter:")} ${query}  ${dim(`${picks.filter((row) => row.kind === "tool").length}/${tools.length}`)}`
          : dim(`  filter: type to filter  ${tools.length}/${tools.length}`),
      );
      const location =
        layer === "session"
          ? "session (in-memory)"
          : sessionDraft
            ? `session override · ${options.configPath}`
            : options.configPath;
      const pathLine = clip(dim(`  ${location}`));
      const hint = clip(dim("  ↑↓ select  ⏎ toggle  Hidden/Visible/Inactive  esc"));
      const chrome = [filterLine, "", pathLine, ""];
      const footer = ["", hint];
      const listBudget = Math.max(1, bodyBudget - chrome.length - footer.length);

      const painted = list.map((row, index) =>
        paintRow(row, index === indexOfSelectable(list, selected), theme, inner, enabled, layer),
      );
      const windowed = windowLines(painted, indexOfSelectable(list, selected), listBudget, dim);
      const body = fitBody([...chrome, ...windowed], footer, bodyBudget, pathLine);
      return renderPanel(body, width, " Tool Block ", theme);
    },
  };
}

function paintToolState(row: Extract<ToolBlockRow, { kind: "tool" }>): string {
  const state = toolBlockRowState(row);
  if (state === "hidden") return "Hidden";
  if (state === "inactive") return "Inactive";
  return "Visible";
}

function paintRow(
  row: ToolBlockRow,
  selected: boolean,
  theme: ThemeLike,
  innerWidth: number,
  enabled: boolean,
  layer: ToolBlockLayer,
): string {
  if (row.kind === "header") {
    const left = ` ${truncateToWidth(row.plugin, Math.max(1, innerWidth - 3), "…")} `;
    const fill = Math.max(0, innerWidth - visibleWidth(left));
    return theme.fg("dim", `${left}${"─".repeat(fill)}`);
  }
  const markerWidth = 2;
  const gap = 2;
  const labelCol = Math.max(12, Math.min(32, Math.floor((innerWidth - markerWidth - gap) * 0.55)));
  const valueCol = Math.max(6, innerWidth - markerWidth - gap - labelCol);
  const marker = selected ? theme.fg("accent", "› ") : "  ";
  const label = row.kind === "layer" ? "Layer" : row.kind === "enabled" ? "Enabled" : row.name;
  const valuePlain =
    row.kind === "layer"
      ? layer === "session"
        ? "Session"
        : "Global"
      : row.kind === "enabled"
        ? enabled
          ? "On"
          : "Off"
        : paintToolState(row);
  const labelText = truncateToWidth(label, labelCol, "…");
  const valueText = truncateToWidth(valuePlain, valueCol, "…");
  const valueColored =
    row.kind === "layer"
      ? theme.fg("accent", valueText)
      : row.kind === "enabled"
        ? enabled
          ? theme.fg("accent", valueText)
          : theme.fg("dim", valueText)
        : toolBlockRowState(row) === "hidden"
          ? theme.fg("accent", valueText)
          : theme.fg("dim", valueText);
  const labelPadded = labelText + " ".repeat(Math.max(0, labelCol - visibleWidth(labelText)));
  const line = `${marker}${labelPadded}${" ".repeat(gap)}${valueColored}`;
  if (selected && theme.bg) return theme.bg("selectedBg", padVisible(line, innerWidth));
  return line;
}

function indexOfSelectable(list: readonly ToolBlockRow[], selectableIndex: number): number {
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.kind === "header") continue;
    if (seen === selectableIndex) return i;
    seen++;
  }
  return 0;
}

function windowLines(lines: string[], selectedAbs: number, budget: number, dim: (s: string) => string): string[] {
  if (lines.length === 0) return [dim("  No matching tools")];
  if (lines.length <= budget) return lines;
  let itemBudget = Math.max(1, budget);
  if (itemBudget >= 2) itemBudget -= 1;
  if (itemBudget >= 2 && lines.length > itemBudget + 1) itemBudget -= 1;
  let start = Math.max(0, Math.min(selectedAbs - Math.floor(itemBudget / 2), lines.length - itemBudget));
  let end = Math.min(start + itemBudget, lines.length);
  if (selectedAbs < start) {
    start = selectedAbs;
    end = Math.min(start + itemBudget, lines.length);
  }
  if (selectedAbs >= end) {
    end = selectedAbs + 1;
    start = Math.max(0, end - itemBudget);
  }
  const out: string[] = [];
  if (start > 0) out.push(dim(`  ... (${start} more above)`));
  out.push(...lines.slice(start, end));
  if (end < lines.length) out.push(dim(`  ... (${lines.length - end} more below)`));
  return out;
}

function fitBody(lines: string[], footer: string[], budget: number, pathLine: string): string[] {
  const body = [...lines];
  while (body.length + footer.length > budget) {
    const blank = body.indexOf("");
    if (blank >= 0) {
      body.splice(blank, 1);
      continue;
    }
    const pathIdx = body.indexOf(pathLine);
    if (pathIdx >= 0) {
      body.splice(pathIdx, 1);
      continue;
    }
    const more = body.findIndex((line) => line.includes("more above") || line.includes("more below"));
    if (more >= 0) {
      body.splice(more, 1);
      continue;
    }
    const dropAt = body.findIndex((line) => !line.includes("›") && !line.includes("filter:") && !line.includes("─"));
    if (dropAt >= 0) {
      body.splice(dropAt, 1);
      continue;
    }
    break;
  }
  body.push(...footer);
  return body;
}

function padVisible(text: string, width: number): string {
  const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function paintLine(theme: ThemeLike, text: string): string {
  return theme.bg ? theme.bg("customMessageBg", text) : text;
}

function renderPanel(body: string[], width: number, title: string, theme: ThemeLike): string[] {
  const inner = Math.max(0, width - 2);
  const heading = visibleWidth(title) <= inner ? title : truncateToWidth(title, inner, "…");
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(heading)));
  const edge = (text: string) => theme.fg("accent", text);
  return [
    paintLine(theme, `${edge("┌")}${edge(padVisible(`${heading}${fill}`, inner))}${edge("┐")}`),
    ...body.map((line) => paintLine(theme, `${edge("│")}${padVisible(line, inner)}${edge("│")}`)),
    paintLine(theme, `${edge("└")}${edge("─".repeat(inner))}${edge("┘")}`),
  ];
}
