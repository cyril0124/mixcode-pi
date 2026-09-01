/**
 * Extension manager panel: list / search / toggle / reload Pi extensions for
 * the active tab or workdir. Upstream pi component style: list state, search
 * state, and async reload status live in this class; input arrives via TUI
 * focus. App state keeps only the routing flag (state.extensionManager.open).
 */

import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { ExtensionManagerEntry, ExtensionReloadResult } from "../../core/extension-manager.js";
import type { MixCodeState } from "../../core/types.js";
import { getActiveTab } from "../../core/tabs.js";
import {
  closeAppOverlay,
  DEFAULT_OVERLAY_MAX_HEIGHT_PERCENT,
  showComponentOverlay,
} from "../app-overlays.js";
import type { MixCodeSubmitRuntime, OverlayTui } from "../app-types.js";
import { DEFAULT_ICON_MODE } from "../../core/mixcode-settings.js";
import { activeRenderTheme, renderWithTheme } from "../rendering/context.js";
import { resolveGlyphs, resolveIconMode, type IconGlyphs } from "../rendering/icons.js";
import { overlayPanel, padLine } from "../rendering/primitives.js";
import { windowStart } from "../rendering/scroll-window.js";
import { themeForId } from "../themes.js";

export interface ExtensionManagerDeps {
  /** Read-only render source (theme, icon mode) and active-tab lookup. */
  state: MixCodeState;
  tui: OverlayTui;
  /** Reload source and entry provider. */
  runtime: MixCodeSubmitRuntime;
  onStateChanged?: (state: MixCodeState) => void | Promise<void>;
}

/**
 * The panel instance currently presented, if any. Guards stale async reload
 * completions: a panel closed (or replaced by a reopen) while its reload was
 * in flight must not repaint or mutate the new panel.
 */
let currentPanel: ExtensionManagerPanel | undefined;

function cloneExtensionManagerEntries(entries: ExtensionManagerEntry[]): ExtensionManagerEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export class ExtensionManagerPanel implements Component {
  selectedIndex = 0;
  detailScrollOffset = 0;
  searchActive = false;
  searchQuery = "";
  entries: ExtensionManagerEntry[];
  selectedKeys: string[] = [];
  message = "";
  error = "";
  working = false;

  constructor(
    private readonly deps: ExtensionManagerDeps,
    entries: ExtensionManagerEntry[],
  ) {
    this.entries = cloneExtensionManagerEntries(entries);
  }

  invalidate(): void {}

  render(width: number): string[] {
    return renderWithTheme(themeForId(this.deps.state.theme), () =>
      renderExtensionManagerInner(this, this.deps.state, width),
    );
  }

  handleInput(data: string): void {
    if (this.searchActive) {
      this.handleSearchKey(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.searchQuery) {
        this.updateSearch("");
        this.deps.tui.requestRender();
        return;
      }
      closeExtensionManager(this.deps.state, this.deps.tui);
      return;
    }
    if (this.working) return; // modal-busy: ignore everything but Esc
    if (data === "/" || decodeKittyPrintable(data) === "/") {
      this.searchActive = true;
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.moveSelection(1);
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
      this.moveSelection(-1);
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveDetails(Math.max(1, extensionManagerBodyRows(this) - 1));
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveDetails(-Math.max(1, extensionManagerBodyRows(this) - 1));
      this.deps.tui.requestRender();
      return;
    }
    if (data === " ") {
      this.toggleSelected();
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.runAction("apply-current");
      return;
    }
    if (data.toLowerCase() === "r") {
      this.runAction("reload-current");
      return;
    }
    if (data.toLowerCase() === "a") {
      this.runAction("reload-workdir");
      return;
    }
  }

  private handleSearchKey(data: string): void {
    if (matchesKey(data, "escape")) {
      this.searchActive = false;
      this.updateSearch("");
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.searchActive = false;
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.moveSelection(1);
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
      this.moveSelection(-1);
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
      const direction = matchesKey(data, "pageDown") ? 1 : -1;
      this.moveDetails(direction * Math.max(1, extensionManagerBodyRows(this) - 1));
      this.deps.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace") || data === "\x7f") {
      const segments = [...SEARCH_GRAPHEME_SEGMENTER.segment(this.searchQuery)];
      const last = segments.at(-1);
      this.updateSearch(last ? this.searchQuery.slice(0, last.index) : "");
      this.deps.tui.requestRender();
      return;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.updateSearch(this.searchQuery + kittyPrintable);
      this.deps.tui.requestRender();
      return;
    }
    if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
      this.updateSearch(this.searchQuery + data);
      this.deps.tui.requestRender();
    }
  }

  private updateSearch(query: string): void {
    this.searchQuery = query;
    this.selectedIndex = 0;
    this.detailScrollOffset = 0;
  }

  private moveSelection(delta: number): void {
    const total = filteredExtensionManagerEntries(this).length;
    if (total === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = (this.selectedIndex + delta + total) % total;
    this.detailScrollOffset = 0;
  }

  private moveDetails(delta: number): void {
    this.detailScrollOffset = Math.max(0, this.detailScrollOffset + delta);
  }

  private toggleSelected(): void {
    const entry = filteredExtensionManagerEntries(this)[this.selectedIndex];
    if (!entry) return;
    entry.enabled = !entry.enabled;
    const selected = new Set(this.selectedKeys);
    if (selected.has(entry.key)) selected.delete(entry.key);
    else selected.add(entry.key);
    this.selectedKeys = [...selected];
    this.message = "";
    this.error = "";
  }

  private runAction(action: "apply-current" | "reload-current" | "reload-workdir"): void {
    const { state, tui, runtime, onStateChanged } = this.deps;
    const active = getActiveTab(state);
    if (!active) throw new Error("Extension manager requires an active agent tab");
    this.working = true;
    this.error = "";
    this.message = "";
    tui.requestRender();
    void (async () => {
      if (action === "apply-current") {
        const selectedKeys = new Set(this.selectedKeys);
        for (const entry of this.entries) {
          if (!selectedKeys.has(entry.key)) continue;
          await runtime.setExtensionEnabled(active.sessionId, entry.key, entry.enabled);
        }
      }
      const results =
        action === "reload-workdir"
          ? await runtime.reloadExtensionManagerWorkdir(active.workdir)
          : [await runtime.reloadExtensionManagerTab(active.sessionId)];
      this.working = false;
      if (currentPanel !== this || !state.extensionManager.open) return;
      this.refreshEntries(runtime, active.sessionId);
      this.message = formatReloadResults(results);
      this.selectedKeys = [];
      await onStateChanged?.(state);
      tui.requestRender();
    })().catch((error: unknown) => {
      this.working = false;
      if (currentPanel !== this || !state.extensionManager.open) return;
      this.error = error instanceof Error ? error.message : String(error);
      tui.requestRender();
    });
  }

  private refreshEntries(runtime: MixCodeSubmitRuntime, sessionId: string): void {
    this.entries = cloneExtensionManagerEntries(runtime.getExtensionManagerEntries(sessionId));
    const visibleEntries = filteredExtensionManagerEntries(this);
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, visibleEntries.length - 1));
    this.detailScrollOffset = 0;
  }
}

export function openExtensionManager(
  state: MixCodeState,
  runtime: MixCodeSubmitRuntime,
  tui: OverlayTui,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): ExtensionManagerPanel {
  const active = getActiveTab(state);
  if (!active) throw new Error("Extension manager requires an active agent tab");
  const panel = new ExtensionManagerPanel(
    { state, tui, runtime, onStateChanged },
    runtime.getExtensionManagerEntries(active.sessionId),
  );
  currentPanel = panel;
  state.extensionManager.open = true;
  showComponentOverlay(tui, panel);
  tui.requestRender();
  return panel;
}

export function closeExtensionManager(state: MixCodeState, tui: OverlayTui): void {
  currentPanel = undefined;
  state.extensionManager.open = false;
  closeAppOverlay(tui);
  tui.requestRender();
}

// Terminal must be at least this wide before the master/detail two-pane layout
// is used; narrower terminals fall back to an enhanced single-column list.
const DOUBLE_PANE_MIN_WIDTH = 80;
// Fraction of the inner content width allocated to the left list column.
const LEFT_COLUMN_RATIO = 0.55;
const SHORTCUT_HINT =
  "↑↓ select  PgUp/PgDn details  / search  Space toggle  Enter save+reload  R tab  A workdir  Esc close";

const SEARCH_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function renderExtensionManagerInner(
  panel: ExtensionManagerPanel,
  state: MixCodeState,
  width: number,
): string[] {
  // Fill the entire overlay width: the overlay wrapper pads every line to
  // `width` with plain (background-less) spaces, so any panel narrower than the
  // overlay leaves a black gutter on the right. Panel == overlay width avoids it.
  const panelWidth = width;
  const entries = filteredExtensionManagerEntries(panel);
  const contentWidth = Math.max(1, panelWidth - 2);
  const iconMode = state.ui?.icons?.mode ?? DEFAULT_ICON_MODE;
  const iconStyle = {
    glyphs: resolveGlyphs(iconMode),
    resolved: resolveIconMode(iconMode),
  };

  const header = [activeRenderTheme.dim(truncateToWidth(SHORTCUT_HINT, contentWidth))];
  if (panel.searchActive || panel.searchQuery) {
    header.push(renderExtensionSearch(panel, entries.length, contentWidth));
  }
  header.push("");
  const statusLines = buildStatusLines(panel);
  const maxBody = extensionManagerBodyRows(panel);

  const lines = [...header, ...statusLines];
  if (!panel.entries.length) {
    lines.push(activeRenderTheme.dim("No Pi extensions loaded for this workdir."));
    return overlayPanel("Extension Manager", lines, panelWidth);
  }
  if (!entries.length) {
    lines.push(activeRenderTheme.dim(`No extensions match "${panel.searchQuery}".`));
    return overlayPanel("Extension Manager", lines, panelWidth);
  }

  const terminalWidth = process.stdout.columns || width;
  const useDoublePane = terminalWidth >= DOUBLE_PANE_MIN_WIDTH;
  const rendered = useDoublePane
    ? renderDoublePane(panel, entries, contentWidth, maxBody, iconStyle)
    : renderSinglePane(panel, entries, contentWidth, maxBody, iconStyle);
  lines.push(...rendered.body);
  if (rendered.footer) lines.push(rendered.footer);
  return overlayPanel("Extension Manager", lines, panelWidth);
}

function renderExtensionSearch(
  panel: ExtensionManagerPanel,
  visibleCount: number,
  width: number,
): string {
  const query = panel.searchQuery || activeRenderTheme.dim("type to filter");
  const prompt = panel.searchActive ? activeRenderTheme.accent("/") : activeRenderTheme.dim("/");
  const count = activeRenderTheme.dim(`${visibleCount}/${panel.entries.length} extensions`);
  return truncateToWidth(`${activeRenderTheme.dim("Search")} ${prompt}${query}  ${count}`, width);
}

function extensionManagerBodyRows(panel: ExtensionManagerPanel): number {
  const statusCount =
    Number(panel.working) + Number(Boolean(panel.error)) + Number(Boolean(panel.message));
  const statusRows = statusCount > 0 ? statusCount + 1 : 0;
  const searchRows = panel.searchActive || panel.searchQuery ? 1 : 0;
  const reserved = 2 + 2 + searchRows + statusRows + 2;
  const termRows = process.stdout.rows || 24;
  const overlayRows = Math.max(
    1,
    Math.floor((termRows * DEFAULT_OVERLAY_MAX_HEIGHT_PERCENT) / 100),
  );
  return Math.max(1, overlayRows - reserved);
}

function buildStatusLines(panel: ExtensionManagerPanel): string[] {
  const out: string[] = [];
  if (panel.working) out.push(activeRenderTheme.accent("Working..."));
  if (panel.error) out.push(activeRenderTheme.error(panel.error));
  if (panel.message) out.push(activeRenderTheme.success(panel.message));
  if (out.length) out.push("");
  return out;
}

// Enhanced single column: status icon + friendly name + inline metadata, with a
// scrolling viewport so long lists never overflow the panel.
type IconStyle = { glyphs: IconGlyphs; resolved: "nerd" | "ascii" };

function renderSinglePane(
  panel: ExtensionManagerPanel,
  entries: ExtensionManagerEntry[],
  width: number,
  maxBody: number,
  iconStyle: IconStyle,
): { body: string[]; footer: string } {
  const selectedKeys = new Set(panel.selectedKeys);
  const bodyRows = Math.max(1, Math.min(maxBody, entries.length));
  const startIndex = windowStart(panel.selectedIndex, entries.length, bodyRows);
  const body: string[] = [];
  for (let i = startIndex; i < startIndex + bodyRows && i < entries.length; i++) {
    const entry = entries[i]!;
    const selected = i === panel.selectedIndex;
    const raw = buildListRow(entry, selected, selectedKeys.has(entry.key), false, iconStyle);
    body.push(selected ? activeRenderTheme.selectedBg(padLine(raw, width)) : padLine(raw, width));
  }
  return {
    body,
    footer: scrollFooter(panel.selectedIndex, entries.length, startIndex, bodyRows),
  };
}

// Master/detail: a scrolling list on the left and the full field set of the
// selected entry on the right, separated by a thin vertical rule.
function renderDoublePane(
  panel: ExtensionManagerPanel,
  entries: ExtensionManagerEntry[],
  contentWidth: number,
  maxBody: number,
  iconStyle: IconStyle,
): { body: string[]; footer: string } {
  const selectedKeys = new Set(panel.selectedKeys);
  const gap = 3; // " │ "
  const leftWidth = Math.max(16, Math.floor((contentWidth - gap) * LEFT_COLUMN_RATIO));
  const rightWidth = Math.max(16, contentWidth - gap - leftWidth);
  const selectedEntry = entries[panel.selectedIndex];
  const detailLines = selectedEntry
    ? buildDetailLines(selectedEntry, rightWidth, selectedKeys.has(selectedEntry.key), iconStyle)
    : [];
  const listVisible = Math.min(entries.length, maxBody);
  const bodyRows = Math.max(1, Math.min(maxBody, Math.max(listVisible, detailLines.length)));
  const startIndex = windowStart(panel.selectedIndex, entries.length, bodyRows);
  const maxDetailStart = Math.max(0, detailLines.length - bodyRows);
  const detailStart = Math.min(panel.detailScrollOffset, maxDetailStart);
  panel.detailScrollOffset = detailStart;
  const sep = ` ${activeRenderTheme.borderMuted("│")} `;
  const body: string[] = [];
  for (let row = 0; row < bodyRows; row++) {
    const entryIndex = startIndex + row;
    const entry = entryIndex < entries.length ? entries[entryIndex] : undefined;
    const selected = entry !== undefined && entryIndex === panel.selectedIndex;
    const leftRaw = entry
      ? buildListRow(entry, selected, selectedKeys.has(entry.key), true, iconStyle)
      : "";
    const rightCell = padLine(detailLines[detailStart + row] ?? "", rightWidth);
    if (selected) {
      // Wrap the entire row in selection background so the right pane doesn't
      // appear "black" by contrast with the highlighted left pane.
      const fullRow = `${padLine(leftRaw, leftWidth)}${sep}${rightCell}`;
      body.push(activeRenderTheme.selectedBg(padLine(fullRow, contentWidth)));
    } else {
      body.push(`${padLine(leftRaw, leftWidth)}${sep}${rightCell}`);
    }
  }
  const footerText = scrollFooter(panel.selectedIndex, entries.length, startIndex, bodyRows);
  const detailFooterText = detailScrollFooter(detailStart, detailLines.length, bodyRows);
  const footer = `${padLine(footerText, leftWidth)}${sep}${padLine(detailFooterText, rightWidth)}`;
  return { body, footer };
}

function detailScrollFooter(startIndex: number, total: number, windowSize: number): string {
  if (total <= windowSize) return "";
  const end = Math.min(total, startIndex + windowSize);
  const hasUp = startIndex > 0;
  const hasDown = end < total;
  return activeRenderTheme.dim(
    `${hasUp ? "▲" : " "} details ${startIndex + 1}-${end}/${total} ${hasDown ? "▼" : ""}`,
  );
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

function extensionStatusIcon(entry: ExtensionManagerEntry, iconStyle: IconStyle): string {
  if (entry.error) {
    return activeRenderTheme.error(iconStyle.resolved === "ascii" ? "!" : "⚠");
  }
  return entry.enabled
    ? activeRenderTheme.success(iconStyle.glyphs.statusOn)
    : activeRenderTheme.dim(iconStyle.glyphs.statusOff);
}

function colorizeName(entry: ExtensionManagerEntry, name: string): string {
  if (entry.error) return activeRenderTheme.error(name);
  return entry.enabled ? activeRenderTheme.text(name) : activeRenderTheme.dim(name);
}

// One list row. `compact` (double-pane) shows only icon + name + pending marker;
// the wide single-pane variant also appends right-aligned source/metrics or the
// load error message.
function buildListRow(
  entry: ExtensionManagerEntry,
  selected: boolean,
  pending: boolean,
  compact: boolean,
  iconStyle: IconStyle,
): string {
  const cursor = selected ? activeRenderTheme.accent("▸ ") : "  ";
  const icon = extensionStatusIcon(entry, iconStyle);
  const name = colorizeName(entry, friendlyExtensionName(entry));
  const pendingMark = pending ? activeRenderTheme.warning(" *") : "";
  const left = `${cursor}${icon} ${name}${pendingMark}`;
  if (compact) return left;
  const metaPlain = entry.error
    ? entry.error
    : `${formatExtensionSource(entry)}  tools ${entry.toolCount}  cmds ${entry.commandCount}`;
  return `${left}  ${entry.error ? activeRenderTheme.error(metaPlain) : activeRenderTheme.dim(metaPlain)}`;
}

// Full field listing for the selected entry shown in the detail pane.
function buildDetailLines(
  entry: ExtensionManagerEntry,
  width: number,
  pending: boolean,
  iconStyle: IconStyle,
): string[] {
  const icon = extensionStatusIcon(entry, iconStyle);
  const name = friendlyExtensionName(entry);
  const lines: string[] = [
    truncateToWidth(`${icon} ${activeRenderTheme.bold(name)}`, width),
    activeRenderTheme.borderMuted("─".repeat(width)),
  ];
  const status = entry.error
    ? activeRenderTheme.error("error")
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
    lines.push(activeRenderTheme.error("error"));
    for (const part of wrapToWidth(entry.error, width - 2)) {
      lines.push(activeRenderTheme.error(`  ${part}`));
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

// Hard-wrap paths and errors by terminal columns without splitting graphemes.
function wrapToWidth(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width));
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

// Derive a human-friendly extension name: package sources use their package
// directory (baseDir); other sources use the entry path. Generic container
// dirs like src/dist are skipped in favor of the real extension directory.
function friendlyExtensionName(entry: ExtensionManagerEntry): string {
  const base = entry.baseDir?.trim();
  if (base && (entry.source.startsWith("npm:") || entry.source.startsWith("git:"))) {
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

function filteredExtensionManagerEntries(panel: ExtensionManagerPanel): ExtensionManagerEntry[] {
  const terms = panel.searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return panel.entries;
  return panel.entries.filter((entry) => {
    const searchable = [
      friendlyExtensionName(entry),
      entry.key,
      entry.source,
      entry.scope,
      entry.origin,
      entry.path,
      entry.resolvedPath,
      entry.baseDir,
      entry.error,
      ...entry.toolNames,
      ...entry.commandNames,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
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

function formatExtensionSource(entry: ExtensionManagerEntry): string {
  const prefix = entry.source === "local" ? "local" : `ext:${entry.source}`;
  return `${prefix}/${entry.scope}`;
}

function formatExtensionPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
