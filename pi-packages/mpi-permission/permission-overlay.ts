// +---------------------------------------------------------------------------+
// |  permission overlay                                                       |
// |  Settings-style editor for permission rules across three layers.          |
// |                                                                           |
// |  Keys: up/down select, enter/space cycle, n new rule (3-step wizard),     |
// |  d delete, esc close/back. Global/Project edits persist immediately;      |
// |  Session stays in memory.                                                 |
// +---------------------------------------------------------------------------+
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  cycleDoomLoop,
  cycleRuleAction,
  removeRule,
  addRule,
  DOOM_LOOP_KEY,
  type PermissionAction,
  type PermissionConfig,
  type PermissionLayer,
} from "./permission-core.js";

export type ThemeLike = {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
};

export interface PermissionOverlayOptions {
  theme: ThemeLike;
  requestRender: () => void;
  done: () => void;
  trusted: boolean;
  paths: { global: string; project: string };
  initial: { global: PermissionConfig; project: PermissionConfig; session: PermissionConfig };
  /** Rule-key suggestions for the new-rule wizard ("*", guards, tool names). */
  knownKeys: readonly string[];
  persist: (
    config: PermissionConfig,
    layer: PermissionLayer,
  ) => { ok: true } | { ok: false; error: string };
  onError?: (message: string) => void;
  getMaxVisible?: () => number;
}

export type PermissionRow =
  | { kind: "layer" }
  | { kind: "doom"; action?: PermissionAction }
  | { kind: "note"; text: string }
  | { kind: "header"; tool: string }
  | { kind: "rule"; tool: string; index: number; pattern: string; action: PermissionAction };

type SelectableRow = Extract<PermissionRow, { kind: "layer" | "doom" | "rule" }>;

const DOOM_NOTE = "same tool + identical input 3× in a row triggers this action · Off = disabled";

/** Rows for one layer draft: layer selector, doom_loop (+note), then key groups. */
export function buildPermissionRows(config: PermissionConfig): PermissionRow[] {
  const rows: PermissionRow[] = [
    { kind: "layer" },
    { kind: "doom", action: config.doomLoop },
    { kind: "note", text: DOOM_NOTE },
  ];
  for (const entry of config.entries) {
    rows.push({ kind: "header", tool: entry.tool });
    entry.rules.forEach((rule, index) => {
      rows.push({ kind: "rule", tool: entry.tool, index, pattern: rule.pattern, action: rule.action });
    });
  }
  return rows;
}

const LAYER_CYCLE: PermissionLayer[] = ["global", "project", "session"];
const ACTION_ORDER: PermissionAction[] = ["allow", "ask", "deny"];
const RESERVED_RULE_KEYS = new Set(["$schema", DOOM_LOOP_KEY]);
const KEY_CANDIDATE_ROWS = 5;

/** New-rule wizard state. Esc steps back; Enter advances. */
type NewRuleInput =
  | { step: "key"; buffer: string; picked: number }
  | { step: "pattern"; key: string; buffer: string }
  | { step: "action"; key: string; pattern: string; action: PermissionAction };

function shiftAction(action: PermissionAction, delta: number): PermissionAction {
  const index = ACTION_ORDER.indexOf(action);
  return ACTION_ORDER[(index + delta + ACTION_ORDER.length) % ACTION_ORDER.length]!;
}

/** Per-key pattern examples shown in wizard step 2. */
function patternExample(key: string): string {
  if (key === "bash") return "* matches everything · e.g. git * · git push* · rm *";
  if (key === "read" || key === "edit" || key === "write" || key === "ls") {
    return "e.g. src/* · *.env · ~/dir/** · /abs/path/*";
  }
  if (key === "external_directory") return "e.g. ~/notes/** · /srv/data/*";
  return "* matches all input · ? matches one character";
}

export function createPermissionOverlay(options: PermissionOverlayOptions): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { theme, requestRender, done } = options;
  let layer: PermissionLayer = "global";
  const drafts: Record<PermissionLayer, PermissionConfig> = {
    global: options.initial.global,
    project: options.initial.project,
    session: options.initial.session,
  };
  let selected = 0;
  let input: NewRuleInput | null = null;

  function rows(): PermissionRow[] {
    return buildPermissionRows(drafts[layer]);
  }

  function selectable(list: PermissionRow[]): SelectableRow[] {
    return list.filter((row): row is SelectableRow => row.kind !== "header" && row.kind !== "note");
  }

  function clampSelected(): void {
    const count = selectable(rows()).length;
    selected = count === 0 ? 0 : Math.min(Math.max(0, selected), count - 1);
  }

  function keyCandidates(buffer: string): string[] {
    const query = buffer.trim().toLowerCase();
    if (!query) return [...options.knownKeys];
    return options.knownKeys.filter((key) => key.toLowerCase().startsWith(query));
  }

  /** Persist-then-remember; failed writes leave the draft untouched. */
  function apply(next: PermissionConfig): boolean {
    const written = options.persist(next, layer);
    if (!written.ok) {
      options.onError?.(written.error);
      return false;
    }
    drafts[layer] = next;
    return true;
  }

  function commitNewRule(key: string, pattern: string, action: PermissionAction): void {
    if (!apply(addRule(drafts[layer], key, pattern, action))) return;
    // Select the just-added rule (last rule row of that key).
    const picks = selectable(rows());
    for (let i = picks.length - 1; i >= 0; i--) {
      const row = picks[i]!;
      if (row.kind === "rule" && row.tool === key && row.pattern === pattern) {
        selected = i;
        break;
      }
    }
  }

  function handleActivate(): void {
    const current = selectable(rows())[selected];
    if (!current) return;
    if (current.kind === "layer") {
      layer = LAYER_CYCLE[(LAYER_CYCLE.indexOf(layer) + 1) % LAYER_CYCLE.length]!;
      clampSelected();
      return;
    }
    if (current.kind === "doom") {
      apply(cycleDoomLoop(drafts[layer]));
      return;
    }
    apply(cycleRuleAction(drafts[layer], current.tool, current.index));
  }

  function handleDelete(): void {
    const current = selectable(rows())[selected];
    if (!current) return;
    if (current.kind === "rule") {
      apply(removeRule(drafts[layer], current.tool, current.index));
      clampSelected();
      return;
    }
    if (current.kind === "doom" && drafts[layer].doomLoop !== undefined) {
      const { doomLoop: _cleared, ...rest } = drafts[layer];
      apply({ ...rest });
    }
  }

  function setBuffer(next: string): void {
    if (!input) return;
    if (input.step === "key") input = { step: "key", buffer: next, picked: 0 };
    else if (input.step === "pattern") input = { step: "pattern", key: input.key, buffer: next };
  }

  function handleWizardInput(data: string): void {
    const wizard = input!;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      // Step back one step; Esc on step 1 cancels the wizard.
      input =
        wizard.step === "key"
          ? null
          : wizard.step === "pattern"
            ? { step: "key", buffer: wizard.key, picked: 0 }
            : { step: "pattern", key: wizard.key, buffer: wizard.pattern };
      requestRender();
      return;
    }
    if (wizard.step === "action") {
      if (matchesKey(data, Key.enter)) {
        input = null;
        commitNewRule(wizard.key, wizard.pattern, wizard.action);
        requestRender();
        return;
      }
      if (
        data === " " ||
        matchesKey(data, Key.left) ||
        matchesKey(data, Key.right) ||
        matchesKey(data, Key.up) ||
        matchesKey(data, Key.down)
      ) {
        const delta = matchesKey(data, Key.left) || matchesKey(data, Key.up) ? -1 : 1;
        input = { ...wizard, action: shiftAction(wizard.action, delta) };
        requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (wizard.step === "key") {
        const picks = keyCandidates(wizard.buffer);
        const chosen = (picks.length > 0 ? picks[wizard.picked] ?? picks[0]! : wizard.buffer).trim();
        if (!chosen) return;
        if (RESERVED_RULE_KEYS.has(chosen)) {
          options.onError?.(`${chosen} is a reserved key, not a rule target`);
          return;
        }
        input = { step: "pattern", key: chosen, buffer: "*" };
      } else {
        const pattern = wizard.buffer.trim();
        if (!pattern) return;
        input = { step: "action", key: wizard.key, pattern, action: "ask" };
      }
      requestRender();
      return;
    }
    if (wizard.step === "key" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      const count = keyCandidates(wizard.buffer).length;
      if (count > 0) {
        const delta = matchesKey(data, Key.up) ? -1 : 1;
        input = { ...wizard, picked: (wizard.picked + delta + count) % count };
        requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (wizard.buffer.length > 0) {
        setBuffer([...wizard.buffer].slice(0, -1).join(""));
        requestRender();
      }
      return;
    }
    if (data.length > 0 && data.charCodeAt(0) >= 0x20 && data !== "\x7f") {
      setBuffer(wizard.buffer + data);
      requestRender();
    }
  }

  function handleInput(data: string): void {
    if (input) {
      handleWizardInput(data);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      done();
      return;
    }
    if (matchesKey(data, Key.enter) || data === " ") {
      handleActivate();
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
    if (data === "n") {
      input = { step: "key", buffer: "", picked: 0 };
      requestRender();
      return;
    }
    if (data === "d") {
      handleDelete();
      requestRender();
      return;
    }
  }

  /** Wizard footer block: prompt line, then candidates or example, then hint. */
  function wizardLines(inner: number): string[] {
    const wizard = input!;
    const clip = (text: string) => truncateToWidth(text, inner, "…");
    const dim = (text: string) => theme.fg("dim", text);
    const lines: string[] = [];
    if (wizard.step === "key") {
      lines.push(clip(`  ${theme.bold("new rule 1/3 · key:")} ${wizard.buffer}▌`));
      const picks = keyCandidates(wizard.buffer);
      if (picks.length === 0) {
        lines.push(clip(dim(`  no known key matches — enter uses "${wizard.buffer.trim()}" as typed`)));
      } else {
        const start = Math.max(
          0,
          Math.min(wizard.picked - Math.floor(KEY_CANDIDATE_ROWS / 2), picks.length - KEY_CANDIDATE_ROWS),
        );
        for (let i = start; i < Math.min(start + KEY_CANDIDATE_ROWS, picks.length); i++) {
          const marker = i === wizard.picked ? theme.fg("accent", "› ") : "  ";
          const name = i === wizard.picked ? theme.fg("accent", picks[i]!) : dim(picks[i]!);
          lines.push(clip(`  ${marker}${name}`));
        }
        if (picks.length > start + KEY_CANDIDATE_ROWS) {
          lines.push(clip(dim(`    … ${picks.length - start - KEY_CANDIDATE_ROWS} more`)));
        }
      }
      lines.push(clip(dim("  ↑↓ pick  type to filter  ⏎ next  esc cancel")));
      return lines;
    }
    if (wizard.step === "pattern") {
      lines.push(clip(`  ${theme.bold(`new rule 2/3 · pattern for ${wizard.key}:`)} ${wizard.buffer}▌`));
      lines.push(clip(dim(`  ${patternExample(wizard.key)}`)));
      lines.push(clip(dim("  ⏎ next  esc back")));
      return lines;
    }
    const choices = ACTION_ORDER.map((action) =>
      action === wizard.action ? theme.fg("accent", `[${action}]`) : dim(` ${action} `),
    ).join(" ");
    lines.push(
      clip(`  ${theme.bold(`new rule 3/3 · action for ${wizard.key}[${wizard.pattern}]:`)} ${choices}`),
    );
    lines.push(clip(dim("  space/←→ choose  ⏎ add rule  esc back")));
    return lines;
  }

  return {
    invalidate() {},
    handleInput,
    render(width: number) {
      clampSelected();
      const list = rows();
      const bodyBudget = Math.max(6, options.getMaxVisible?.() ?? 12);
      const inner = Math.max(1, width - 2);
      const clip = (text: string) => truncateToWidth(text, inner, "…");
      const dim = (text: string) => theme.fg("dim", text);

      const location =
        layer === "global"
          ? options.paths.global
          : layer === "project"
            ? `${options.paths.project}${options.trusted ? "" : " (untrusted — ignored)"}`
            : "session (in-memory)";
      const pathLine = clip(dim(`  ${location}`));
      const footer = input
        ? ["", ...wizardLines(inner)]
        : ["", clip(dim("  ↑↓ select  ⏎ cycle allow/ask/deny  n new  d delete  esc"))];
      const chrome = [pathLine, ""];
      const listBudget = Math.max(1, bodyBudget - chrome.length - footer.length);

      const painted = list.map((row, index) =>
        paintRow(row, index === indexOfSelectable(list, selected), theme, inner, layer),
      );
      if (list.length === 3) painted.push(dim("  No rules — press n to add"));
      const windowed = windowLines(painted, indexOfSelectable(list, selected), listBudget, dim);
      const body = fitBody([...chrome, ...windowed], footer, bodyBudget, pathLine);
      return renderPanel(body, width, " Permission ", theme);
    },
  };
}

function paintRow(
  row: PermissionRow,
  selected: boolean,
  theme: ThemeLike,
  innerWidth: number,
  layer: PermissionLayer,
): string {
  if (row.kind === "note") {
    return theme.fg("dim", truncateToWidth(`    ${row.text}`, innerWidth, "…"));
  }
  if (row.kind === "header") {
    const left = ` ${truncateToWidth(row.tool, Math.max(1, innerWidth - 3), "…")} `;
    const fill = Math.max(0, innerWidth - visibleWidth(left));
    return theme.fg("dim", `${left}${"─".repeat(fill)}`);
  }
  const markerWidth = 2;
  const gap = 2;
  const labelCol = Math.max(12, Math.min(48, Math.floor((innerWidth - markerWidth - gap) * 0.7)));
  const valueCol = Math.max(6, innerWidth - markerWidth - gap - labelCol);
  const marker = selected ? theme.fg("accent", "› ") : "  ";
  const label = row.kind === "layer" ? "Layer" : row.kind === "doom" ? DOOM_LOOP_KEY : row.pattern;
  const valuePlain =
    row.kind === "layer"
      ? layer === "global"
        ? "Global"
        : layer === "project"
          ? "Project"
          : "Session"
      : row.kind === "doom"
        ? (row.action ?? "Off")
        : row.action;
  const labelText = truncateToWidth(label, labelCol, "…");
  const valueText = truncateToWidth(valuePlain, valueCol, "…");
  const valueColored =
    row.kind === "layer"
      ? theme.fg("accent", valueText)
      : row.kind === "doom"
        ? valueText === "Off"
          ? theme.fg("dim", valueText)
          : theme.fg("accent", valueText)
        : row.action === "deny"
          ? theme.fg("error", valueText)
          : row.action === "ask"
            ? theme.fg("warning", valueText)
            : theme.fg("dim", valueText);
  const labelPadded = labelText + " ".repeat(Math.max(0, labelCol - visibleWidth(labelText)));
  const line = `${marker}${labelPadded}${" ".repeat(gap)}${valueColored}`;
  if (selected && theme.bg) return theme.bg("selectedBg", padVisible(line, innerWidth));
  return line;
}

function indexOfSelectable(list: readonly PermissionRow[], selectableIndex: number): number {
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    const kind = list[i]!.kind;
    if (kind === "header" || kind === "note") continue;
    if (seen === selectableIndex) return i;
    seen++;
  }
  return 0;
}

function windowLines(lines: string[], selectedAbs: number, budget: number, dim: (s: string) => string): string[] {
  if (lines.length === 0) return [dim("  No rules")];
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
    const dropAt = body.findIndex((line) => !line.includes("›") && !line.includes("─"));
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
