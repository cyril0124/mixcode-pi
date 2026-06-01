import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionReloadResult } from "../core/extension-manager.js";
import type { ExtensionManagerEntryInfo, MixCodeState } from "../core/types.js";
import { closeAppOverlay, showErrorOverlay, showLinesOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, MixCodeSubmitRuntime, OverlayTui } from "./app-types.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { overlayPanel, padLine } from "./rendering/primitives.js";
import { themeForId } from "./themes.js";

export function openExtensionManager(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  tui: OverlayTui,
): void {
  const active = activeExtensionManagerTab(state);
  if (!active) throw new Error("Extension manager requires an active agent tab");
  if (!runtime.getExtensionManagerEntries)
    throw new Error("Extension manager requires runtime extension metadata support");
  state.extensionManager = {
    open: true,
    selectedIndex: 0,
    entries: runtime.getExtensionManagerEntries(active.sessionId),
    selectedKeys: [],
    message: "",
    error: "",
    working: false,
  };
  showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
}

export function renderExtensionManager(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderExtensionManagerInner(state, width));
}

// Terminal must be at least this wide before the master/detail two-pane layout
// is used; narrower terminals fall back to an enhanced single-column list.
const DOUBLE_PANE_MIN_WIDTH = 80;
// Fraction of the inner content width allocated to the left list column.
const LEFT_COLUMN_RATIO = 0.55;
const SHORTCUT_HINT =
  "space: toggle  enter: save+reload  r: reload tab  a: reload workdir  esc: close";

function renderExtensionManagerInner(state: MixCodeState, width: number): string[] {
  // Fill the entire overlay width: the LinesOverlay wrapper pads every line to
  // `width` with plain (background-less) spaces, so any panel narrower than the
  // overlay leaves a black gutter on the right. Panel == overlay width avoids it.
  const panelWidth = width;
  const manager = state.extensionManager;
  const entries = manager.entries;
  const contentWidth = Math.max(1, panelWidth - 2);

  const header = [activeRenderTheme.dim(truncateToWidth(SHORTCUT_HINT, contentWidth)), ""];
  const statusLines = buildStatusLines(manager);

  // Reserve rows for panel borders, header, status banners and the scroll
  // footer so the body window never pushes the panel past the terminal height.
  const reserved = 2 + header.length + statusLines.length + 2;
  const termRows = process.stdout.rows || 24;
  const maxBody = Math.max(5, termRows - reserved);

  const lines = [...header, ...statusLines];
  if (!entries.length) {
    lines.push(activeRenderTheme.dim("No Pi extensions loaded for this workdir."));
    return overlayPanel("Extension Manager", lines, panelWidth);
  }

  const useDoublePane = width >= DOUBLE_PANE_MIN_WIDTH;
  const rendered = useDoublePane
    ? renderDoublePane(manager, contentWidth, maxBody)
    : renderSinglePane(manager, contentWidth, maxBody);
  lines.push(...rendered.body);
  if (rendered.footer) lines.push(rendered.footer);
  return overlayPanel("Extension Manager", lines, panelWidth);
}

function buildStatusLines(manager: MixCodeState["extensionManager"]): string[] {
  const out: string[] = [];
  if (manager.working) out.push(activeRenderTheme.accent("Working..."));
  if (manager.error) out.push(activeRenderTheme.danger(manager.error));
  if (manager.message) out.push(activeRenderTheme.success(manager.message));
  if (out.length) out.push("");
  return out;
}

// Enhanced single column: status icon + friendly name + inline metadata, with a
// scrolling viewport so long lists never overflow the panel.
function renderSinglePane(
  manager: MixCodeState["extensionManager"],
  width: number,
  maxBody: number,
): { body: string[]; footer: string } {
  const entries = manager.entries;
  const selectedKeys = new Set(manager.selectedKeys);
  const bodyRows = Math.max(1, Math.min(maxBody, entries.length));
  const startIndex = windowStart(manager.selectedIndex, entries.length, bodyRows);
  const body: string[] = [];
  for (let i = startIndex; i < startIndex + bodyRows && i < entries.length; i++) {
    const entry = entries[i]!;
    const selected = i === manager.selectedIndex;
    const raw = buildListRow(entry, selected, selectedKeys.has(entry.key), false);
    body.push(
      selected ? activeRenderTheme.selection(padLine(raw, width)) : padLine(raw, width),
    );
  }
  return {
    body,
    footer: scrollFooter(manager.selectedIndex, entries.length, startIndex, bodyRows),
  };
}

// Master/detail: a scrolling list on the left and the full field set of the
// selected entry on the right, separated by a thin vertical rule.
function renderDoublePane(
  manager: MixCodeState["extensionManager"],
  contentWidth: number,
  maxBody: number,
): { body: string[]; footer: string } {
  const entries = manager.entries;
  const selectedKeys = new Set(manager.selectedKeys);
  const gap = 3; // " │ "
  const leftWidth = Math.max(16, Math.floor((contentWidth - gap) * LEFT_COLUMN_RATIO));
  const rightWidth = Math.max(16, contentWidth - gap - leftWidth);
  const selectedEntry = entries[manager.selectedIndex];
  const detailLines = selectedEntry
    ? buildDetailLines(selectedEntry, rightWidth, selectedKeys.has(selectedEntry.key))
    : [];
  const listVisible = Math.min(entries.length, maxBody);
  const bodyRows = Math.max(1, Math.min(maxBody, Math.max(listVisible, detailLines.length)));
  const startIndex = windowStart(manager.selectedIndex, entries.length, bodyRows);
  const sep = ` ${activeRenderTheme.borderDim("│")} `;
  const body: string[] = [];
  for (let row = 0; row < bodyRows; row++) {
    const entryIndex = startIndex + row;
    const entry = entryIndex < entries.length ? entries[entryIndex] : undefined;
    const selected = entry !== undefined && entryIndex === manager.selectedIndex;
    const leftRaw = entry
      ? buildListRow(entry, selected, selectedKeys.has(entry.key), true)
      : "";
    const rightCell = padLine(detailLines[row] ?? "", rightWidth);
    if (selected) {
      // Wrap the entire row in selection background so the right pane doesn't
      // appear "black" by contrast with the highlighted left pane.
      const fullRow = `${padLine(leftRaw, leftWidth)}${sep}${rightCell}`;
      body.push(activeRenderTheme.selection(padLine(fullRow, contentWidth)));
    } else {
      body.push(`${padLine(leftRaw, leftWidth)}${sep}${rightCell}`);
    }
  }
  const footerText = scrollFooter(manager.selectedIndex, entries.length, startIndex, bodyRows);
  // Keep the separator visual continuity in the footer row.
  const footer = footerText
    ? `${padLine(footerText, leftWidth)}${sep}${padLine("", rightWidth)}`
    : "";
  return { body, footer };
}

// Keep the selected index centered within a fixed-height scrolling window.
function windowStart(selectedIndex: number, total: number, windowSize: number): number {
  if (total <= windowSize) return 0;
  return Math.max(0, Math.min(selectedIndex - Math.floor(windowSize / 2), total - windowSize));
}

function scrollFooter(
  selectedIndex: number,
  total: number,
  startIndex: number,
  windowSize: number,
): string {
  if (total === 0) return "";
  const hasUp = startIndex > 0;
  const hasDown = startIndex + windowSize < total;
  const position = `(${selectedIndex + 1}/${total})`;
  const scroll = hasUp || hasDown ? `   ${hasUp ? "▲" : " "} ${hasDown ? "▼" : " "} scroll` : "";
  return activeRenderTheme.dim(`  ${position}${scroll}`);
}

function extensionStatusIcon(entry: ExtensionManagerEntryInfo): string {
  if (entry.error) return activeRenderTheme.danger("⚠");
  return entry.enabled ? activeRenderTheme.success("●") : activeRenderTheme.dim("○");
}

function colorizeName(entry: ExtensionManagerEntryInfo, name: string): string {
  if (entry.error) return activeRenderTheme.danger(name);
  return entry.enabled ? activeRenderTheme.text(name) : activeRenderTheme.dim(name);
}

// One list row. `compact` (double-pane) shows only icon + name + pending marker;
// the wide single-pane variant also appends right-aligned source/metrics or the
// load error message.
function buildListRow(
  entry: ExtensionManagerEntryInfo,
  selected: boolean,
  pending: boolean,
  compact: boolean,
): string {
  const cursor = selected ? activeRenderTheme.accent("▸ ") : "  ";
  const icon = extensionStatusIcon(entry);
  const name = colorizeName(entry, friendlyExtensionName(entry));
  const pendingMark = pending ? activeRenderTheme.warning(" *") : "";
  const left = `${cursor}${icon} ${name}${pendingMark}`;
  if (compact) return left;
  const metaPlain = entry.error
    ? entry.error
    : `${formatExtensionSource(entry)}  tools ${entry.toolCount}  cmds ${entry.commandCount}`;
  return `${left}  ${entry.error ? activeRenderTheme.danger(metaPlain) : activeRenderTheme.dim(metaPlain)}`;
}

// Full field listing for the selected entry shown in the detail pane.
function buildDetailLines(
  entry: ExtensionManagerEntryInfo,
  width: number,
  pending: boolean,
): string[] {
  const icon = extensionStatusIcon(entry);
  const name = friendlyExtensionName(entry);
  const lines: string[] = [
    truncateToWidth(`${icon} ${activeRenderTheme.bold(name)}`, width),
    activeRenderTheme.borderDim("─".repeat(width)),
  ];
  const status = entry.error
    ? activeRenderTheme.danger("error")
    : entry.enabled
      ? activeRenderTheme.success("enabled")
      : activeRenderTheme.dim("disabled");
  lines.push(detailField("status", status, width));
  if (pending) {
    const target = entry.enabled ? "enable on save" : "disable on save";
    lines.push(detailField("pending", activeRenderTheme.warning(target), width));
  }
  lines.push(detailField("source", entry.source, width));
  lines.push(detailField("scope", entry.scope, width));
  lines.push(detailField("origin", entry.origin, width));
  lines.push(...detailNameList("tools", entry.toolCount, entry.toolNames, width, false));
  lines.push(...detailNameList("commands", entry.commandCount, entry.commandNames, width, true));
  lines.push(activeRenderTheme.dim("path"));
  for (const part of wrapToWidth(formatExtensionPath(entry.path), width - 2)) {
    lines.push(`  ${part}`);
  }
  if (entry.resolvedPath && entry.resolvedPath !== entry.path) {
    lines.push(activeRenderTheme.dim("resolved"));
    for (const part of wrapToWidth(formatExtensionPath(entry.resolvedPath), width - 2)) {
      lines.push(`  ${part}`);
    }
  }
  if (entry.error) {
    lines.push(activeRenderTheme.danger("error"));
    for (const part of wrapToWidth(entry.error, width - 2)) {
      lines.push(activeRenderTheme.danger(`  ${part}`));
    }
  }
  return lines;
}

function detailField(label: string, value: string, width: number): string {
  const head = activeRenderTheme.dim(label.padEnd(9));
  return truncateToWidth(`${head}${value}`, width);
}

// A count header (e.g. "tools    3") followed by one indented "· name" row per
// entry. Command names get a leading "/" to match how they are invoked. Each
// name occupies a single line and is truncated to the detail pane width.
function detailNameList(
  label: string,
  count: number,
  names: string[],
  width: number,
  isCommand: boolean,
): string[] {
  const lines = [detailField(label, String(count), width)];
  for (const name of names) {
    const display = isCommand ? `/${name}` : name;
    lines.push(truncateToWidth(`  ${activeRenderTheme.dim("·")} ${display}`, width));
  }
  return lines;
}

// Hard-wrap plain text (paths / error messages) into width-bounded chunks.
function wrapToWidth(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const out: string[] = [];
  let rest = text;
  while (visibleWidth(rest) > width) {
    out.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  out.push(rest);
  return out;
}

// Generic container directory names that are never meaningful extension names;
// when a derived segment matches one of these we walk up to the parent folder.
const GENERIC_SEGMENTS = new Set(["src", "dist", "lib", "out", "build", "index"]);

// Pick the last path segment that is not a generic container dir (src/dist/...).
function meaningfulSegment(segments: string[]): string | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (!GENERIC_SEGMENTS.has(segment.toLowerCase())) return segment;
  }
  return segments[segments.length - 1];
}

// Derive a human-friendly extension name: prefer the package directory name
// (baseDir), otherwise infer it from the file path (dropping an index.* file).
// Generic container dirs like src/dist are skipped in favor of the real package.
function friendlyExtensionName(entry: ExtensionManagerEntryInfo): string {
  const base = entry.baseDir?.trim();
  if (base) {
    const segment = meaningfulSegment(base.split(/[/\\]/).filter(Boolean));
    if (segment) return segment;
  }
  const path = entry.path;
  if (!path || path === "<inline>") return path || "extension";
  const parts = path.split(/[/\\]/).filter(Boolean);
  // Drop a trailing index.* entry file so we name by its containing directory.
  if (parts.length && /^index\.[a-z]+$/i.test(parts[parts.length - 1]!)) parts.pop();
  const segment = meaningfulSegment(parts);
  if (!segment) return path;
  return segment.replace(/\.[a-z]+$/i, "") || path;
}

export function handleExtensionManagerKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  if (!state.extensionManager.open) return false;
  if (matchesKey(data, "escape")) {
    closeExtensionManager(state, tui);
    return true;
  }
  if (state.extensionManager.working) return true;
  if (matchesKey(data, "down") || matchesKey(data, "tab")) {
    moveExtensionManagerSelection(state, 1);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    return true;
  }
  if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
    moveExtensionManagerSelection(state, -1);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    return true;
  }
  if (data === " ") {
    toggleSelectedExtension(state);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    return true;
  }
  if (matchesKey(data, "enter")) {
    runExtensionManagerAction(state, tui, runtime, onStateChanged, "apply-current");
    return true;
  }
  if (data.toLowerCase() === "r") {
    runExtensionManagerAction(state, tui, runtime, onStateChanged, "reload-current");
    return true;
  }
  if (data.toLowerCase() === "a") {
    runExtensionManagerAction(state, tui, runtime, onStateChanged, "reload-workdir");
    return true;
  }
  return true;
}

function runExtensionManagerAction(
  state: MixCodeState,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged: ((state: MixCodeState) => void | Promise<void>) | undefined,
  action: "apply-current" | "reload-current" | "reload-workdir",
): void {
  const active = activeExtensionManagerTab(state);
  if (!active) throw new Error("Extension manager requires an active agent tab");
  if (!runtime?.reloadExtensionManagerTab || !runtime.reloadExtensionManagerWorkdir) {
    throw new Error("Extension manager requires runtime reload support");
  }
  const runtimeWithReload = runtime as MixCodeKeyRuntime &
    Required<
      Pick<MixCodeKeyRuntime, "reloadExtensionManagerTab" | "reloadExtensionManagerWorkdir">
    >;
  state.extensionManager.working = true;
  state.extensionManager.error = "";
  state.extensionManager.message = "";
  showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
  void (async () => {
    if (action === "apply-current")
      await persistExtensionManagerToggles(state, runtimeWithReload, active.sessionId);
    const results =
      action === "reload-workdir"
        ? await runtimeWithReload.reloadExtensionManagerWorkdir(active.workdir)
        : [await runtimeWithReload.reloadExtensionManagerTab(active.sessionId)];
    refreshExtensionManagerEntries(state, runtimeWithReload, active.sessionId);
    state.extensionManager.message = formatReloadResults(results);
    state.extensionManager.selectedKeys = [];
    state.extensionManager.working = false;
    await onStateChanged?.(state);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    tui.requestRender();
  })().catch((error: unknown) => {
    state.extensionManager.working = false;
    state.extensionManager.error = error instanceof Error ? error.message : String(error);
    showErrorOverlay(tui, error);
    showLinesOverlay(tui, (width) => renderExtensionManager(state, width));
    tui.requestRender();
  });
}

async function persistExtensionManagerToggles(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime,
  sessionId: string,
): Promise<void> {
  if (!runtime.setExtensionEnabled)
    throw new Error("Extension manager requires runtime persistence support");
  const selectedKeys = new Set(state.extensionManager.selectedKeys);
  for (const entry of state.extensionManager.entries) {
    if (!selectedKeys.has(entry.key)) continue;
    await runtime.setExtensionEnabled(sessionId, entry.key, entry.enabled);
  }
}

function refreshExtensionManagerEntries(
  state: MixCodeState,
  runtime: MixCodeKeyRuntime,
  sessionId: string,
): void {
  if (!runtime.getExtensionManagerEntries) return;
  state.extensionManager.entries = runtime.getExtensionManagerEntries(sessionId);
  state.extensionManager.selectedIndex = Math.min(
    state.extensionManager.selectedIndex,
    Math.max(0, state.extensionManager.entries.length - 1),
  );
}

function closeExtensionManager(state: MixCodeState, tui: OverlayTui): void {
  state.extensionManager.open = false;
  state.extensionManager.selectedIndex = 0;
  state.extensionManager.selectedKeys = [];
  closeAppOverlay(tui);
  tui.requestRender();
}

function moveExtensionManagerSelection(state: MixCodeState, delta: number): void {
  const total = state.extensionManager.entries.length;
  if (total === 0) {
    state.extensionManager.selectedIndex = 0;
    return;
  }
  state.extensionManager.selectedIndex =
    (state.extensionManager.selectedIndex + delta + total) % total;
}

function toggleSelectedExtension(state: MixCodeState): void {
  const entry = state.extensionManager.entries[state.extensionManager.selectedIndex];
  if (!entry) return;
  entry.enabled = !entry.enabled;
  const selected = new Set(state.extensionManager.selectedKeys);
  if (selected.has(entry.key)) selected.delete(entry.key);
  else selected.add(entry.key);
  state.extensionManager.selectedKeys = [...selected];
  state.extensionManager.message = "";
  state.extensionManager.error = "";
}

function activeExtensionManagerTab(state: MixCodeState): MixCodeState["tabs"][number] | undefined {
  return state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
}

function formatReloadResults(results: ExtensionReloadResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  return [
    `reloaded:${counts.get("reloaded") ?? 0}`,
    `skipped:${counts.get("skipped") ?? 0}`,
    `errors:${counts.get("error") ?? 0}`,
  ].join("  ");
}

function formatExtensionSource(entry: ExtensionManagerEntryInfo): string {
  const prefix = entry.source === "local" ? "local" : `ext:${entry.source}`;
  return `${prefix}/${entry.scope}`;
}

function formatExtensionPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
