import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import pkg from "../../../package.json" with { type: "json" };
import {
  fuzzyMatchAllPositions,
  fuzzyMatchPositions,
  substringMatchPositions,
} from "../../core/fuzzy.js";
import {
  filterTabJumpEntries,
  selectableCommandPaletteEntries,
  tabJumpEntries,
} from "../../core/overlays.js";
import { filteredPickerItems, workdirBreadcrumb } from "../../core/pickers.js";
import { activeToast } from "../../core/toast.js";
import type { ChatLine } from "../../agent/runtime-types.js";
import type { MixCodeState } from "../../core/types.js";
import { homeVisibleTabIndices } from "../../core/tabs.js";
import { tabIsWaitingForInput } from "../../core/tab-state.js";
import { type MixCodeTheme, themeForId } from "../themes.js";
import { compactWorkdir, exactContextUsageText, formatElapsed, tabStatusGlyph } from "./chrome.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { highlightRanges } from "./highlight.js";
import { joinColumns } from "./layout.js";
import { overlayPanel, padLine } from "./primitives.js";
import { applyToastOverlay } from "../components/toast-overlay.js";
import { halfScreenRows, windowStart } from "./scroll-window.js";

/** Shared match style for dynamic fuzzy-search highlighting across overlays: bold + accent. */
function matchHighlight(text: string): string {
  return activeRenderTheme.bold(activeRenderTheme.accent(text));
}

export function renderHome(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
  rowOffset = 0,
  maxRows?: number,
  chatForTab?: (sessionId: string) => readonly ChatLine[] | undefined,
): string[] {
  return renderWithTheme(theme, () =>
    renderHomeInner(state, width, rowOffset, maxRows, chatForTab),
  );
}

function renderHomeInner(
  state: MixCodeState,
  width: number,
  _rowOffset: number,
  maxRows: number | undefined,
  chatForTab: ((sessionId: string) => readonly ChatLine[] | undefined) | undefined,
): string[] {
  const height = maxRows === undefined ? undefined : Math.max(0, Math.floor(maxRows));
  const inset = width >= 80 ? 3 : width >= 4 ? 1 : 0;
  const bodyWidth = Math.max(0, width - inset * 2);
  const brand = `${activeRenderTheme.accent(activeRenderTheme.bold("MixCode"))} ${activeRenderTheme.dim("/ HOME")}`;
  const workdir = process.env.MIXCODE_DISPLAY_WORKDIR?.trim() || state.workdir;
  const busy = state.tabs.filter(
    (tab) => tab.status === "running" || tab.status === "thinking",
  ).length;
  const waiting = state.tabs.filter(tabIsWaitingForInput).length;
  const activity = [
    busy ? activeRenderTheme.accent(`${busy} working`) : "",
    waiting ? activeRenderTheme.warning(`${waiting} input`) : "",
  ]
    .filter(Boolean)
    .join(activeRenderTheme.dim("  ·  "));
  const header = [
    ...(height === undefined || height >= 18 ? [""] : []),
    homeLineEnds(brand, activeRenderTheme.dim(`v${pkg.version}`), bodyWidth),
    homeLineEnds(
      activeRenderTheme.dim(
        compactWorkdir(
          singleLinePreview(workdir),
          Math.max(0, bodyWidth - visibleWidth(activity) - (activity ? 2 : 0)),
        ),
      ),
      activity,
      bodyWidth,
    ),
    activeRenderTheme.borderMuted("─".repeat(bodyWidth)),
    ...(height === undefined || height >= 18 ? [""] : []),
  ];
  const updates = renderPackageUpdateNotice(state.packageUpdates, bodyWidth);
  // Reserve space for the selected agent and navigation even with many update notices.
  const headerBudget =
    height === undefined ? header.length + updates.length : Math.max(0, height - 4);
  const top = [...header, ...updates].slice(0, headerBudget);
  if (
    updates.length > 0 &&
    header.length + updates.length > headerBudget &&
    top.length > header.length
  ) {
    top[top.length - 1] = activeRenderTheme.warning(
      "… more package updates · pi update --extensions",
    );
  }
  const body = renderAgentViewTable(
    state,
    bodyWidth,
    height === undefined ? undefined : height - top.length,
    chatForTab,
  );
  const lines = [...top, ...body].map((line) =>
    padLine(`${" ".repeat(inset)}${padLine(line, bodyWidth)}`, width),
  );
  const selected = state.tabs[state.homeSelectedTabIndex];
  // Home has no agent surface; the selected agent still owns its transient notices.
  return selected
    ? applyToastOverlay(
        lines,
        activeToast(selected),
        width,
        height ?? lines.length,
        activeRenderTheme,
      )
    : lines;
}

/** Keep trailing metadata aligned without letting it displace the leading label. */
function homeLineEnds(left: string, right: string, width: number): string {
  if (!right || visibleWidth(right) + 4 > width) return padLine(left, width);
  const leftWidth = Math.max(0, width - visibleWidth(right) - 2);
  return `${padLine(truncateToWidth(left, leftWidth, "…"), leftWidth)}  ${right}`;
}

const AGENT_CARD_HEIGHT = 4;
const PREVIEW_HEIGHT_PERCENT = 15;
const MIN_PREVIEW_ROWS = 4;
const DEFAULT_PREVIEW_ROWS = 6;
const AGENT_VIEW_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const AGENT_VIEW_SPINNER_INTERVAL_MS = 80;
const HOME_PREVIEW_TEXT_LIMIT = 16_384;

// Plain-text caches follow tab/message lifetimes and retain only the current viewport shape.
const homeSummaryCache = new WeakMap<
  MixCodeState["tabs"][number],
  {
    source: string;
    width: number;
    text: string;
  }
>();
const homeTailCache = new WeakMap<
  ChatLine,
  {
    source: string;
    width: number;
    rows: number;
    lines: string[];
    clipped: boolean;
  }
>();

function renderAgentViewTable(
  state: MixCodeState,
  width: number,
  maxRows: number | undefined,
  chatForTab: ((sessionId: string) => readonly ChatLine[] | undefined) | undefined,
): string[] {
  const budget = maxRows === undefined ? undefined : Math.max(0, Math.floor(maxRows));
  const visible = homeVisibleTabIndices(state);
  const heading = `${activeRenderTheme.bold("Agents")} ${activeRenderTheme.dim(String(visible.length))}${state.homeNonIdleOnly ? `  ${activeRenderTheme.selectedBg(" non-idle ")}` : ""}`;
  const hints = [
    "↑/↓: select",
    "→: attach",
    "Enter: send",
    "Tab: cycle tabs",
    state.homeNonIdleOnly ? "Ctrl+F: all" : "Ctrl+F: non-idle",
  ];
  let hint = hints.join("  ");
  while (visibleWidth(hint) > width && hints.length > 2) {
    hints.splice(Math.max(2, hints.length - 2), 1);
    hint = hints.join("  ");
  }
  const finish = (lines: string[]): string[] => {
    const content = budget === undefined ? lines : lines.slice(0, Math.max(0, budget - 1));
    if (budget !== undefined) while (content.length < budget - 1) content.push("");
    if (budget !== 0) content.push(activeRenderTheme.dim(hint));
    return content;
  };
  const emptyMessage = activeRenderTheme.dim(
    state.tabs.length === 0 ? "No agent sessions." : "No non-idle agents.",
  );
  // In tiny viewports the selected agent takes precedence over section chrome and hints.
  if (budget !== undefined && budget < 4) {
    if (budget === 0) return [];
    const rows =
      visible.length === 0
        ? [emptyMessage]
        : renderAgentRoster(state, width, Math.max(1, budget - 1), chatForTab);
    return budget === 1 ? rows.slice(0, 1) : finish(rows);
  }
  const rule = activeRenderTheme.borderMuted("─".repeat(width));
  if (visible.length === 0) {
    return finish([heading, rule, emptyMessage]);
  }
  const selectedIndex = visible.includes(state.homeSelectedTabIndex)
    ? state.homeSelectedTabIndex
    : visible[0]!;
  const selectedTab = state.tabs[selectedIndex]!;
  const bodyRows = budget === undefined ? undefined : Math.max(0, budget - 3);
  // Split only when both the roster and a readable conversation fit the viewport.
  if (width >= 114 && (budget === undefined || budget >= 18)) {
    const listWidth = Math.floor((width - 3) * 0.44);
    const previewWidth = width - listWidth - 3;
    const roster = renderAgentRoster(state, listWidth, bodyRows, chatForTab);
    const detailRows = bodyRows ?? Math.max(roster.length, 12);
    const left = [heading, activeRenderTheme.borderMuted("─".repeat(listWidth)), ...roster];
    const right = [
      homeLineEnds(
        activeRenderTheme.bold("Conversation"),
        formatTabStatusChip(selectedTab),
        previewWidth,
      ),
      activeRenderTheme.borderMuted("─".repeat(previewWidth)),
      ...renderConversationPreview(selectedTab, previewWidth, detailRows, chatForTab),
    ];
    const height = Math.max(left.length, right.length);
    while (right.length < height) right.push("");
    return finish(
      joinColumns(
        left,
        right.map((line) => `${activeRenderTheme.borderMuted("│")} ${line}`),
        listWidth,
        previewWidth + 2,
      ),
    );
  }
  const previewRows = previewSlotRows(bodyRows);
  const rosterRows = bodyRows === undefined ? undefined : Math.max(0, bodyRows - previewRows);
  const lines = [heading, rule, ...renderAgentRoster(state, width, rosterRows, chatForTab)];
  if (previewRows > 0) {
    lines.push(
      ...renderPreviewPanel(
        selectedTab,
        width,
        budget === undefined ? previewRows : budget - 1 - lines.length,
        chatForTab,
      ),
    );
  }
  return finish(lines);
}

function renderAgentRoster(
  state: MixCodeState,
  width: number,
  budget: number | undefined,
  chatForTab: ((sessionId: string) => readonly ChatLine[] | undefined) | undefined,
): string[] {
  if (budget === 0) return [];
  const visible = homeVisibleTabIndices(state);
  const selectedPosition = Math.max(0, visible.indexOf(state.homeSelectedTabIndex));
  const windowed = budget !== undefined && visible.length * AGENT_CARD_HEIGHT > budget;
  const markers = windowed && budget >= AGENT_CARD_HEIGHT + 2;
  const count =
    budget === undefined
      ? visible.length
      : Math.max(1, Math.floor((budget - (markers ? 2 : 0)) / AGENT_CARD_HEIGHT));
  const start = windowStart(selectedPosition, visible.length, count);
  const end = Math.min(visible.length, start + count);
  const lines: string[] = [];
  if (markers && start > 0) lines.push(activeRenderTheme.dim("↑ older above"));
  const now = Date.now();
  for (let index = start; index < end; index++) {
    const tab = state.tabs[visible[index]!]!;
    lines.push(...renderAgentCard(tab, width, index === selectedPosition, now, chatForTab));
  }
  if (markers && end < visible.length) lines.push(activeRenderTheme.dim("↓ newer below"));
  return budget === undefined ? lines : lines.slice(0, budget);
}

/** Compact screens give rows to the roster before allocating a message preview. */
function previewSlotRows(budget: number | undefined): number {
  if (budget === undefined) return DEFAULT_PREVIEW_ROWS;
  const slot = Math.floor((budget * PREVIEW_HEIGHT_PERCENT) / 100);
  return slot >= MIN_PREVIEW_ROWS && budget >= AGENT_CARD_HEIGHT + slot ? slot : 0;
}

function renderAgentCard(
  tab: MixCodeState["tabs"][number],
  width: number,
  selected: boolean,
  now: number,
  chatForTab: ((sessionId: string) => readonly ChatLine[] | undefined) | undefined,
): string[] {
  const marker = selected ? activeRenderTheme.accent("› ") : "  ";
  const status = formatTabStatusChip(tab);
  const spinner = formatAgentSpinner(tab, now);
  // Keep room for an eight-column agent identifier before allocating the status label.
  const statusGroup = truncateToWidth(
    spinner ? `${spinner} ${status}` : status,
    Math.max(0, width - 14),
    "…",
  );
  const titleBudget = Math.max(1, width - visibleWidth(statusGroup) - 6);
  const title = formatAgentCardTitleSegment(
    tab,
    `${tabStatusGlyph(tab)} ${truncateToWidth(singleLinePreview(tab.title), titleBudget, "…")}`,
  );
  const rows = [
    homeLineEnds(`${marker}${title}`, statusGroup, width),
    padLine(`  ${formatAgentCardMeta(tab, new Date(now))}`, width),
    activeRenderTheme.dim(
      padLine(
        `  ⎿ ${latestAssistantPreview(tab, chatForTab?.(tab.sessionId) ?? [], Math.max(0, width - 4))}`,
        width,
      ),
    ),
  ];
  return [...rows.map((line) => (selected ? activeRenderTheme.selectedBg(line) : line)), ""];
}

function renderPreviewPanel(
  tab: MixCodeState["tabs"][number],
  width: number,
  maxRows: number,
  chatForTab: ((sessionId: string) => readonly ChatLine[] | undefined) | undefined,
): string[] {
  if (maxRows <= 0) return [];
  const innerWidth = Math.max(0, width - 2);
  const divider = `${activeRenderTheme.borderMuted("─".repeat(width))}`;
  if (maxRows === 1) return [divider];
  const messages = previewPanelMessages(chatForTab?.(tab.sessionId) ?? [], maxRows - 1);
  if (messages.length === 0) {
    return [divider, activeRenderTheme.dim("  No messages yet")].slice(0, maxRows);
  }
  const lines = messages.map((msg) => {
    const prefix = ` ${activeRenderTheme.dim(`${msg.role}:`)} `;
    const prefixWidth = visibleWidth(prefix);
    const textBudget = Math.max(1, innerWidth - prefixWidth);
    const text =
      msg.role === "tools"
        ? formatToolCallPreview(msg.count, textBudget)
        : truncateToWidth(singleLinePreview(msg.message.text), textBudget, "...");
    return `${prefix}${msg.role === "tools" ? activeRenderTheme.dim(text) : text}`;
  });
  return [divider, ...lines];
}

function renderConversationPreview(
  tab: MixCodeState["tabs"][number],
  width: number,
  maxRows: number,
  chatForTab: ((sessionId: string) => readonly ChatLine[] | undefined) | undefined,
): string[] {
  const workdir = process.env.MIXCODE_DISPLAY_WORKDIR?.trim() || tab.workdir;
  const heading = [
    activeRenderTheme.bold(truncateToWidth(singleLinePreview(tab.title), width, "…")),
    activeRenderTheme.dim(compactWorkdir(singleLinePreview(workdir), width)),
    "",
  ];
  const available = Math.max(0, maxRows - heading.length);
  const messages = previewPanelMessages(chatForTab?.(tab.sessionId) ?? [], available + 1);
  const content: string[] = [];
  // Collect from the tail so offscreen messages never enter wrapping or width caches.
  for (let index = messages.length - 1; index >= 0 && content.length <= available; index--) {
    const message = messages[index]!;
    if (content.length > 0) content.push("");
    const role = message.role === "user" ? activeRenderTheme.accent : activeRenderTheme.dim;
    const prefix = `${role(`${message.role}:`)} `;
    const indent = visibleWidth(prefix);
    const body =
      message.role === "tools"
        ? {
            lines: [activeRenderTheme.dim(formatToolCallPreview(message.count, width - indent))],
            clipped: false,
          }
        : wrappedPreviewTail(message.message, Math.max(1, width - indent), available + 1);
    for (let row = body.lines.length - 1; row >= 0 && content.length <= available; row--) {
      content.push(`${row === 0 ? prefix : " ".repeat(indent)}${body.lines[row]}`);
    }
  }
  content.reverse();
  if (content.length === 0) content.push(activeRenderTheme.dim("No messages yet"));
  // One extra row distinguishes a complete preview from clipped history.
  const tail =
    content.length > available && available > 1
      ? [activeRenderTheme.dim("↑ earlier messages"), ...content.slice(-(available - 1))]
      : available === 0
        ? []
        : content;
  return [...heading, ...tail].slice(0, maxRows);
}

function wrappedPreviewTail(message: ChatLine, width: number, rows: number) {
  const cached = homeTailCache.get(message);
  if (cached?.source === message.text && cached.width === width && cached.rows === rows)
    return cached;
  const wrapped = Bun.wrapAnsi(singleLinePreview(message.text), width, { hard: true }).split("\n");
  const value = {
    source: message.text,
    width,
    rows,
    lines: wrapped.slice(-rows),
    clipped: message.text.length > HOME_PREVIEW_TEXT_LIMIT || wrapped.length > rows,
  };
  homeTailCache.set(message, value);
  return value;
}

type PreviewPanelMessage =
  | { role: "user" | "assistant"; message: ChatLine }
  | { role: "tools"; count: number };

function previewPanelMessages(
  messages: readonly ChatLine[],
  maxMessages: number,
): PreviewPanelMessage[] {
  const rows: PreviewPanelMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "tool" && message.role !== "user" && message.role !== "assistant")
      continue;
    const previous = rows.at(-1);
    // Finish a tool group even when it is the oldest visible row; its count must be exact.
    if (message.role === "tool" && previous?.role === "tools") {
      previous.count += 1;
      continue;
    }
    if (rows.length >= maxMessages) break;
    rows.push(
      message.role === "tool" ? { role: "tools", count: 1 } : { role: message.role, message },
    );
  }
  return rows.reverse();
}

function formatToolCallPreview(count: number, width: number): string {
  const countText = String(count);
  const dots = "·".repeat(Math.min(count, Math.max(0, width - countText.length - 2)));
  return truncateToWidth(`${dots}  ${countText}`, width, "");
}

function formatAgentCardTitleSegment(tab: MixCodeState["tabs"][number], text: string): string {
  if (tab.status === "error") return activeRenderTheme.error(text);
  if (tabIsWaitingForInput(tab)) return activeRenderTheme.toolTitle(text);
  if (tab.status === "running" || tab.status === "thinking") return activeRenderTheme.accent(text);
  if (tab.status === "done" || tab.unreadDone) return activeRenderTheme.done(text);
  return text;
}

function formatAgentSpinner(tab: MixCodeState["tabs"][number], now: number): string {
  if (tab.status !== "running" && tab.status !== "thinking") return "";
  const start = tab.workingStartedAt ? Date.parse(tab.workingStartedAt) : NaN;
  // If startedAt is unavailable, use wall-clock time so the spinner still animates.
  const elapsed = Number.isFinite(start) ? Math.max(0, now - start) : now;
  const frame =
    AGENT_VIEW_SPINNER_FRAMES[
      Math.floor(elapsed / AGENT_VIEW_SPINNER_INTERVAL_MS) % AGENT_VIEW_SPINNER_FRAMES.length
    ];
  return activeRenderTheme.accent(frame ?? AGENT_VIEW_SPINNER_FRAMES[0]!);
}

function formatTabStatusChip(tab: MixCodeState["tabs"][number]): string {
  if (tabIsWaitingForInput(tab)) {
    return activeRenderTheme.toolTitle("[input]");
  }
  // Prefer unread-done over bare idle so Home cards match the tab-bar `!` glyph.
  if (tab.unreadDone && (tab.status === "idle" || tab.status === "done")) {
    return activeRenderTheme.toolTitle("[done]");
  }
  // Only the live tab status owns the error chip. Do not infer error from
  // historical system messages — recovered sessions stay idle/done.
  if (tab.status === "error") {
    return activeRenderTheme.error("[error]");
  }
  // Loading tabs show the live phase instead of the generic status word.
  if (tab.status === "Not Ready") {
    return activeRenderTheme.dim(`[${tab.loadingPhase ?? "loading"}]`);
  }
  const text = `[${tab.status}]`;
  switch (tab.status) {
    case "running":
    case "thinking":
      return activeRenderTheme.accent(text);
    case "done":
      return activeRenderTheme.toolTitle(text);
    default:
      return activeRenderTheme.dim(text);
  }
}

function formatAgentCardMeta(tab: MixCodeState["tabs"][number], now = new Date()): string {
  // MIXCODE_DISPLAY_MODEL masks the card model the same way the bottom meta
  // bar is masked, so demos/GIFs hide the real provider across every surface.
  const model =
    process.env.MIXCODE_DISPLAY_MODEL?.trim() ||
    tab.model.modelId.split("/").pop() ||
    tab.model.modelId;
  const context = activeRenderTheme.dim(exactContextUsageText(tab));
  const updated = formatTabUpdated(tab, now);
  return updated ? `${model} · ${context} · ${updated}` : `${model} · ${context}`;
}

/** Relative recency for Home cards from lastWorkedAt — not run duration. */
function formatTabUpdated(tab: MixCodeState["tabs"][number], now = new Date()): string {
  if (tab.status === "running" || tab.status === "thinking") {
    return `${tab.status} ${formatElapsed(tab.workingStartedAt, now)}`;
  }
  if (!tab.lastWorkedAt) return "";
  const at = Date.parse(tab.lastWorkedAt);
  if (!Number.isFinite(at)) return "";
  const secs = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function latestAssistantPreview(
  tab: MixCodeState["tabs"][number],
  chat: readonly ChatLine[],
  width: number,
): string {
  // Prefer assistant, then bash/system so Home cards don't stay stuck on
  // "No output yet" after bash or error-only turns.
  const picks: Array<(line: ChatLine) => boolean> = [
    (line) => line.role === "assistant",
    (line) => line.role === "user" && line.variant === "user-bash",
    (line) => line.role === "system",
    (line) => line.role === "user",
  ];
  for (const pred of picks) {
    const latest = chat.findLast(pred);
    if (!latest) continue;
    const cached = homeSummaryCache.get(tab);
    if (cached?.source === latest.text && cached.width === width) return cached.text;
    const text = singleLinePreview(latest.text);
    if (!text) continue;
    // Clip before adding the non-ASCII tree glyph or ANSI styling so full outputs
    // never enter Pi's decorated-line width cache.
    const preview = truncateToWidth(text, width);
    homeSummaryCache.set(tab, { source: latest.text, width, text: preview });
    return preview;
  }
  return "No output yet";
}

function singleLinePreview(text: string | undefined): string {
  const source = text ?? "";
  const bounded =
    source.length > HOME_PREVIEW_TEXT_LIMIT ? source.slice(-HOME_PREVIEW_TEXT_LIMIT) : source;
  const plain = stripTerminalSequences(bounded).trim();
  // Avoid rebuilding already-normalized large strings on every streaming update.
  return /[^\S ]| {2}/u.test(plain) ? plain.replace(/\s+/g, " ") : plain;
}

function renderPackageUpdateNotice(packages: string[], width: number): string[] {
  if (!packages.length) return [];
  return [
    activeRenderTheme.warning(activeRenderTheme.bold("Package Updates Available")),
    activeRenderTheme.dim("pi update --extensions"),
    ...packages.map((name) =>
      activeRenderTheme.dim(truncateToWidth(`- ${singleLinePreview(name)}`, width, "…")),
    ),
    "",
  ];
}

export function renderCommandPalette(
  state: MixCodeState,
  width: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): string[] {
  return renderWithTheme(themeForId(state.theme), () =>
    renderCommandPaletteInner(state, width, extensionCommands),
  );
}

/** Body-line plan for Command Palette list rows; shared by render + mouse hit-testing. */
export function planCommandPaletteList(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): {
  entries: ReturnType<typeof selectableCommandPaletteEntries>;
  startIndex: number;
  endIndex: number;
  showMoreAbove: boolean;
  showMoreBelow: boolean;
  empty: boolean;
  /** 0-based body line (inside the box, under the top border) → entry index. */
  entryBodyLines: Array<{ bodyLine: number; entryIndex: number }>;
  bodyLineCount: number;
} {
  const entries = selectableCommandPaletteEntries(state, extensionCommands);
  if (!entries.length) {
    // search, separator, "No matching commands", blank, help
    return {
      entries,
      startIndex: 0,
      endIndex: 0,
      showMoreAbove: false,
      showMoreBelow: false,
      empty: true,
      entryBodyLines: [],
      bodyLineCount: 5,
    };
  }
  const maxVisible = halfScreenRows();
  const startIndex = windowStart(state.commandPalette.selectedIndex, entries.length, maxVisible);
  const endIndex = Math.min(startIndex + maxVisible, entries.length);
  const showMoreAbove = startIndex > 0;
  const showMoreBelow = endIndex < entries.length;
  // search + separator, optional more-above, entries, optional more-below, blank + help
  let bodyLine = 2;
  if (showMoreAbove) bodyLine += 1;
  const entryBodyLines: Array<{ bodyLine: number; entryIndex: number }> = [];
  for (let entryIndex = startIndex; entryIndex < endIndex; entryIndex++) {
    entryBodyLines.push({ bodyLine, entryIndex });
    bodyLine += 1;
  }
  if (showMoreBelow) bodyLine += 1;
  bodyLine += 2;
  return {
    entries,
    startIndex,
    endIndex,
    showMoreAbove,
    showMoreBelow,
    empty: false,
    entryBodyLines,
    bodyLineCount: bodyLine,
  };
}

function renderCommandPaletteInner(
  state: MixCodeState,
  width: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): string[] {
  if (!state.commandPaletteOpen) return [];
  const plan = planCommandPaletteList(state, extensionCommands);
  const innerWidth = Math.max(1, width - 2);

  // Search row with ">" prefix
  const searchPrefix = activeRenderTheme.accent(">");
  const queryText = state.commandPalette.query || " ";
  const searchLine = ` ${searchPrefix} ${queryText}`;

  // Separator between search and list
  const separator = activeRenderTheme.border("─".repeat(innerWidth));

  // Column width allocation: marker(2) + label(40%) + gap(2) + cmd(25%) + gap(2) + desc(35%)
  const markerWidth = 2;
  const gapTotal = 4;
  const remaining = Math.max(0, innerWidth - markerWidth - gapTotal);
  const labelCol = Math.max(6, Math.floor(remaining * 0.4));
  const cmdCol = Math.max(6, Math.floor(remaining * 0.25));
  const descCol = Math.max(4, remaining - labelCol - cmdCol);

  const lines: string[] = [searchLine, separator];

  if (plan.empty) {
    lines.push(activeRenderTheme.dim("  No matching commands"));
  } else {
    // Highlight only the searchable columns. Description stays dim because it
    // does not participate in command palette filtering.
    const paletteQuery = state.commandPalette.query.trim();
    if (plan.showMoreAbove) {
      lines.push(activeRenderTheme.dim(`  ... (${plan.startIndex} more above)`));
    }
    for (let index = plan.startIndex; index < plan.endIndex; index++) {
      const entry = plan.entries[index]!;
      const isSelected = index === state.commandPalette.selectedIndex;
      const marker = isSelected ? "› " : "  ";
      const label = truncateToWidth(entry.label, labelCol, "…");
      const cmd = truncateToWidth(entry.command, cmdCol, "…");
      const desc = truncateToWidth(entry.description, descCol, "…");

      const coloredLabel = highlightRanges(
        label,
        fuzzyMatchAllPositions(paletteQuery, label),
        matchHighlight,
      );
      const coloredCmd = highlightRanges(
        cmd,
        fuzzyMatchAllPositions(paletteQuery, cmd),
        matchHighlight,
        activeRenderTheme.accent,
      );
      // Description is not part of the palette filter (see
      // commandPaletteEntriesWithExtensions), so it must render as static dim
      // text without query highlighting — otherwise matched chars would light
      // up in a column that never participated in the match decision.
      const coloredDesc = activeRenderTheme.dim(desc);

      const labelPadded = coloredLabel + " ".repeat(Math.max(0, labelCol - visibleWidth(label)));
      const cmdPadded = coloredCmd + " ".repeat(Math.max(0, cmdCol - visibleWidth(cmd)));

      const row = `${marker}${labelPadded}  ${cmdPadded}  ${coloredDesc}`;

      if (isSelected) {
        lines.push(activeRenderTheme.selectedBg(padLine(row, innerWidth)));
      } else {
        lines.push(row);
      }
    }
    if (plan.showMoreBelow) {
      lines.push(
        activeRenderTheme.dim(`  ... (${plan.entries.length - plan.endIndex} more below)`),
      );
    }
  }

  lines.push("", activeRenderTheme.dim("  ↑↓ select  ⏎ run  esc close"));
  return overlayPanel("Command Palette", lines, width);
}

export function renderTabJumpOverlay(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderTabJumpOverlayInner(state, width));
}

/** Body-line plan for Tab Jump list rows; shared by render + mouse hit-testing. */
export function planTabJumpList(state: MixCodeState): {
  entries: ReturnType<typeof filterTabJumpEntries>;
  startIndex: number;
  endIndex: number;
  showMoreAbove: boolean;
  showMoreBelow: boolean;
  empty: boolean;
  /** 0-based body line (inside the box, under the top border) → entry index. */
  entryBodyLines: Array<{ bodyLine: number; entryIndex: number }>;
  /** Total body lines before the box border is applied. */
  bodyLineCount: number;
} {
  const entries = filterTabJumpEntries(state, state.tabJumpQuery);
  if (!entries.length) {
    // search, blank, "No matching tabs", blank, help
    return {
      entries,
      startIndex: 0,
      endIndex: 0,
      showMoreAbove: false,
      showMoreBelow: false,
      empty: true,
      entryBodyLines: [],
      bodyLineCount: 5,
    };
  }
  const maxVisible = halfScreenRows();
  const startIndex = windowStart(state.tabJumpIndex, entries.length, maxVisible);
  const endIndex = Math.min(startIndex + maxVisible, entries.length);
  const showMoreAbove = startIndex > 0;
  const showMoreBelow = endIndex < entries.length;
  // search + blank, optional more-above, entries, optional more-below, blank + help
  let bodyLine = 2;
  if (showMoreAbove) bodyLine += 1;
  const entryBodyLines: Array<{ bodyLine: number; entryIndex: number }> = [];
  for (let entryIndex = startIndex; entryIndex < endIndex; entryIndex++) {
    entryBodyLines.push({ bodyLine, entryIndex });
    bodyLine += 1;
  }
  if (showMoreBelow) bodyLine += 1;
  bodyLine += 2;
  return {
    entries,
    startIndex,
    endIndex,
    showMoreAbove,
    showMoreBelow,
    empty: false,
    entryBodyLines,
    bodyLineCount: bodyLine,
  };
}

function renderTabJumpOverlayInner(state: MixCodeState, width: number): string[] {
  if (!state.tabJumpOpen) return [];
  const plan = planTabJumpList(state);
  // Denominator is unfiltered total so 2/5 still means "2 of 5 tabs match".
  const totalTabs = tabJumpEntries(state).length;
  const innerWidth = Math.max(1, width - 2);
  const searchText = state.tabJumpQuery || "";
  const modeTag = state.tabJumpNonIdleOnly ? " non-idle" : "";
  const countText = `${plan.entries.length}/${totalTabs} tabs${modeTag}`;
  const searchPrefix = activeRenderTheme.dim("Search");
  const searchLeft = ` ${searchPrefix}  ${activeRenderTheme.accent(searchText)}`;
  const searchGap = Math.max(1, innerWidth - visibleWidth(searchLeft) - visibleWidth(countText));
  const lines = [`${searchLeft}${" ".repeat(searchGap)}${activeRenderTheme.dim(countText)}`, ""];
  if (plan.empty) {
    lines.push(activeRenderTheme.dim("No matching tabs"));
  } else {
    if (plan.showMoreAbove) {
      lines.push(activeRenderTheme.dim(`... (${plan.startIndex} more above)`));
    }
    for (let index = plan.startIndex; index < plan.endIndex; index++) {
      const entry = plan.entries[index]!;
      const line = renderTabJumpRow(
        entry,
        index === state.tabJumpIndex,
        innerWidth,
        state.tabJumpQuery,
      );
      lines.push(
        index === state.tabJumpIndex
          ? activeRenderTheme.selectedBg(padLine(line, innerWidth))
          : line,
      );
    }
    if (plan.showMoreBelow) {
      lines.push(activeRenderTheme.dim(`... (${plan.entries.length - plan.endIndex} more below)`));
    }
  }
  lines.push(
    "",
    activeRenderTheme.dim("filter · ↑↓/ctrl+j/k/tab · ctrl+f non-idle · enter jump · esc cancel"),
  );
  return overlayPanel("Tab Jump", lines, width);
}

function renderTabJumpRow(
  entry: ReturnType<typeof filterTabJumpEntries>[number],
  selected: boolean,
  width: number,
  query: string,
): string {
  const cursor = selected ? activeRenderTheme.accent("›") : " ";
  const status = formatTabJumpStatus(entry);
  const leftWidth = visibleWidth(cursor) + 1 + visibleWidth(status) + 2;
  const displayId = formatTabJumpId(entry.id, entry.label, width - leftWidth - 2);
  const id = activeRenderTheme.dim(displayId);
  const idWidth = visibleWidth(displayId);
  const titleWidth = Math.max(1, width - leftWidth - idWidth - 2);
  const truncatedTitle = truncateToWidth(entry.label, titleWidth, "...");
  const title = highlightRanges(
    truncatedTitle,
    fuzzyMatchAllPositions(query, truncatedTitle),
    matchHighlight,
    tabJumpBaseStyle(entry),
  );
  const left = `${cursor} ${status}  ${title}`;
  const gap = Math.max(1, width - visibleWidth(left) - idWidth);
  return `${left}${" ".repeat(gap)}${id}`;
}

function formatTabJumpStatus(entry: ReturnType<typeof filterTabJumpEntries>[number]): string {
  if (entry.waitingForInput) return activeRenderTheme.warning("?");
  if (entry.busy) return activeRenderTheme.accent("*");
  if (entry.done) return activeRenderTheme.done("!");
  return " ";
}

function formatTabJumpId(id: string, label: string, availableWidth: number): string {
  if (id.length <= 12) return id;
  const fullIdWidth = visibleWidth(id);
  const labelWidth = visibleWidth(label);
  if (labelWidth + 1 + fullIdWidth <= availableWidth) return id;
  return id.slice(0, 8);
}

function tabJumpBaseStyle(
  entry: ReturnType<typeof filterTabJumpEntries>[number],
): (text: string) => string {
  if (entry.waitingForInput) return activeRenderTheme.toolTitle;
  if (entry.busy) return activeRenderTheme.accent;
  if (entry.done) return activeRenderTheme.done;
  return (text: string) => text;
}

export function renderPickerOverlay(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderPickerOverlayInner(state, width));
}

function renderPickerOverlayInner(state: MixCodeState, width: number): string[] {
  const picker = state.picker;
  if (!picker) return [];
  const items = filteredPickerItems(picker);

  // Workdir picker has a custom layout with breadcrumb and icons
  if (picker.kind === "workdir") {
    return renderWorkdirPickerOverlay(picker, items, width);
  }

  // Context-limit picker: custom input mode
  if (picker.kind === "context-limit" && picker.customInputMode) {
    return renderContextLimitCustomInput(picker, width);
  }

  const lines = [`filter: ${picker.query}`, ""];
  if (!items.length) {
    lines.push("No matching items");
  } else {
    const pickerQuery = picker.query.trim();
    const maxVisible = halfScreenRows();
    const startIndex = windowStart(picker.selectedIndex, items.length, maxVisible);
    const endIndex = Math.min(startIndex + maxVisible, items.length);
    if (startIndex > 0) {
      lines.push(activeRenderTheme.dim(`  ... (${startIndex} more above)`));
    }
    for (let index = startIndex; index < endIndex; index++) {
      const item = items[index]!;
      const label = highlightRanges(
        item.label,
        fuzzyMatchPositions(pickerQuery, item.label),
        matchHighlight,
      );
      const description = highlightRanges(
        item.description,
        fuzzyMatchPositions(pickerQuery, item.description),
        matchHighlight,
      );
      const line = `${index === picker.selectedIndex ? ">" : " "} ${label}  ${description}`;
      const rendered = item.disabled ? activeRenderTheme.dim(line) : line;
      lines.push(
        index === picker.selectedIndex
          ? activeRenderTheme.selectedBg(padLine(rendered, Math.max(1, width - 2)))
          : rendered,
      );
    }
    if (endIndex < items.length) {
      lines.push(activeRenderTheme.dim(`  ... (${items.length - endIndex} more below)`));
    }
  }
  lines.push("", "type: filter  up/down: select  enter: choose  esc: cancel");
  return overlayPanel(picker.title, lines, width);
}

function renderWorkdirPickerOverlay(
  picker: NonNullable<MixCodeState["picker"]>,
  items: ReturnType<typeof filteredPickerItems>,
  width: number,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const breadcrumb = workdirBreadcrumb(picker);
  const breadcrumbLine = breadcrumb
    .map((seg, i) =>
      i === breadcrumb.length - 1 ? activeRenderTheme.warning(seg) : activeRenderTheme.accent(seg),
    )
    .join(activeRenderTheme.dim(" / "));

  const filterLine = picker.query
    ? `${activeRenderTheme.dim("filter:")} ${picker.query}`
    : activeRenderTheme.dim("type to filter");

  const lines: string[] = [breadcrumbLine, filterLine, ""];

  if (!items.length) {
    lines.push(activeRenderTheme.dim("  (empty directory)"));
  } else {
    // Workdir entries are filtered by plain substring `.includes()`, not fuzzy
    // subsequence matching, so highlight the same way for accurate feedback.
    const dirQuery = picker.query.trim();
    const maxVisible = halfScreenRows();
    const startIndex = windowStart(picker.selectedIndex, items.length, maxVisible);
    const endIndex = Math.min(startIndex + maxVisible, items.length);
    if (startIndex > 0) {
      lines.push(activeRenderTheme.dim(`  ... (${startIndex} more above)`));
    }
    for (let index = startIndex; index < endIndex; index++) {
      const item = items[index]!;
      const icon = item.completeValue ? "\u{1F4C1}" : "\u{1F4C4}";
      const label = highlightRanges(
        item.label,
        substringMatchPositions(dirQuery, item.label),
        matchHighlight,
      );
      const line = `${index === picker.selectedIndex ? ">" : " "} ${icon} ${label}  ${activeRenderTheme.dim(item.description)}`;
      lines.push(
        index === picker.selectedIndex
          ? activeRenderTheme.selectedBg(padLine(line, innerWidth))
          : line,
      );
    }
    if (endIndex < items.length) {
      lines.push(activeRenderTheme.dim(`  ... (${items.length - endIndex} more below)`));
    }
  }

  const hiddenIndicator = picker.showHidden ? "on" : "off";
  const itemCount = items.length;
  lines.push(
    "",
    activeRenderTheme.dim(
      `${itemCount} dirs \u00b7 \u2190: parent  tab: enter dir  enter: set workdir  ctrl+h: hidden(${hiddenIndicator})  esc: cancel`,
    ),
  );
  return overlayPanel(picker.title, lines, width);
}

function renderContextLimitCustomInput(
  picker: NonNullable<MixCodeState["picker"]>,
  width: number,
): string[] {
  const lines: string[] = ["Enter context limit (e.g. 32k, 40000)", "", `> ${picker.query}_`];
  if (picker.customInputError) {
    lines.push(activeRenderTheme.error(`\u2716 ${picker.customInputError}`));
  }
  lines.push("", activeRenderTheme.dim("enter: confirm  esc: back"));
  return overlayPanel(picker.title, lines, width);
}
