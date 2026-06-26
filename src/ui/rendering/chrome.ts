import { execFileSync } from "node:child_process";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RuntimeTab } from "../../agent/runtime.js";
import { isPendingEscapeActive } from "../../core/escape.js";
import type { MouseHitRegion } from "../../core/mouse.js";
import type { MixCodeState, MixCodeTabInfo } from "../../core/types.js";
import { tabHasPendingUserInteraction } from "../../core/user-interactions.js";
import type { MixCodeTheme } from "../themes.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { padLine, sanitizeTerminalText } from "./primitives.js";

const GIT_BRANCH_CACHE_TTL_MS = 2_000;
const DEFAULT_WORKING_INDICATOR_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_WORKING_INDICATOR_INTERVAL_MS = 80;
const gitBranchCache = new Map<string, { value: string; expiresAt: number }>();

export function renderHeader(width: number, theme: MixCodeTheme = activeRenderTheme): string[] {
  void width;
  void theme;
  return [];
}

export function renderExtensionHeader(tab: MixCodeTabInfo | undefined, width: number): string[] {
  const header = tab?.extensionUi.header;
  return renderExtensionComponentSlot(header?.render ? header.render(width) : header?.lines, width);
}

export function renderTabBar(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => {
    const line = activeRenderTheme.text(
      padLine(
        tabBarSegments(state)
          .map((segment) => segment.text)
          .join(" "),
        width,
      ),
    );
    return [line];
  });
}

export function tabBarHitRegions(state: MixCodeState): MouseHitRegion[] {
  let cursor = 1;
  return tabBarSegments(state).map((segment) => {
    const startX = cursor;
    const endX = cursor + visibleWidth(segment.text) - 1;
    cursor = endX + 2;
    return { id: segment.id, startX, endX };
  });
}

export function renderStatus(
  tab: MixCodeTabInfo | undefined,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderStatusInner(tab, width));
}

function renderStatusInner(tab: MixCodeTabInfo | undefined, width: number): string[] {
  if (!tab) return [padLine(activeRenderTheme.dim("MixCode Home | no active agent"), width)];
  return [];
}

function renderCompactContextUsage(tab: MixCodeTabInfo): string {
  const tokens = tab.currentContextTokens;
  const limit = tab.contextLimit;
  const overrideMark = tab.contextLimitOverridden ? "*" : "";
  if (tokens === undefined) return `?/${formatCompactTokenCount(limit)}${overrideMark}`;
  const percent =
    limit > 0 ? Math.min(999, Math.max(0, Math.round((tokens / limit) * 100))) : undefined;
  const text =
    percent === undefined
      ? `${formatCompactTokenCount(tokens)}/${formatCompactTokenCount(limit)}${overrideMark}`
      : `${formatCompactTokenCount(tokens)}/${formatCompactTokenCount(limit)}${overrideMark} (${percent}%)`;
  if (percent === undefined) return text;
  if (percent >= 80) return activeRenderTheme.danger(text);
  if (percent >= 50) return activeRenderTheme.accent(text);
  return activeRenderTheme.success(text);
}

function formatCompactTokenCount(tokens: number): string {
  const value = tokens / 1_000;
  if (Number.isInteger(value)) return `${value.toFixed(0)}k`;
  return `${tokens < 10_000 ? value.toFixed(2) : value.toFixed(1)}k`;
}

export function renderSidebar(
  tab: MixCodeTabInfo,
  width: number,
  runtimeTab?: RuntimeTab,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderSidebarInner(tab, width, runtimeTab));
}

export function renderSidebarInner(
  tab: MixCodeTabInfo,
  width: number,
  runtimeTab?: RuntimeTab,
): string[] {
  void tab;
  void width;
  void runtimeTab;
  return [];
}

export function renderInputMeta(
  tab: MixCodeTabInfo,
  width: number,
  row = 0,
  theme: MixCodeTheme = activeRenderTheme,
  updateHitRegions = true,
): string[] {
  return renderWithTheme(theme, () => renderInputMetaInner(tab, width, row, updateHitRegions));
}

function renderInputMetaInner(
  tab: MixCodeTabInfo,
  width: number,
  row = 0,
  updateHitRegions = true,
): string[] {
  const lineWidth = Math.max(0, width - 1);
  const escapeHint = isPendingEscapeActive(tab, "abort-agent") ? " | Esc again: stop" : "";
  const model = tab.model.displayName || "-";
  const thinking = tab.thinkingLevel[0]!.toUpperCase() + tab.thinkingLevel.slice(1);
  const contextBadge = ` ${renderCompactContextUsage(tab)} `;
  const right = chooseInputMetaRight(contextBadge, lineWidth, [
    () => {
      const gitBadge = `  ${gitBranchForWorkdir(tab.workdir) || "-"} `;
      const git = activeRenderTheme.accent(activeRenderTheme.bold(gitBadge));
      return `${contextBadge} ${git}`;
    },
    () => contextBadge,
  ]);
  const leftBudget = Math.max(0, lineWidth - visibleWidth(right) - 1);
  const left = renderInputMetaLeft(tab.workdir, model, thinking, escapeHint, leftBudget);
  const gap = Math.max(1, lineWidth - visibleWidth(left.text) - visibleWidth(right));
  const metaRow =
    visibleWidth(left.text) + visibleWidth(right) + 1 <= lineWidth
      ? `${left.text}${" ".repeat(gap)}${right}`
      : `${left.text} ${right}`;
  if (updateHitRegions) {
    tab.inputMetaHitRegions = left.regions.map((region) => ({ ...region, row }));
  }
  const lines = [padLine(metaRow, lineWidth)];
  const extLine = buildExtensionStatusLine(tab, Math.max(0, width - 1));
  if (extLine) lines.push(extLine);
  return lines;
}

function renderInputMetaLeft(
  workdirPath: string,
  model: string,
  thinking: string,
  escapeHint: string,
  width: number,
): {
  text: string;
  regions: Array<{ action: "models" | "thinking" | "workdir"; startX: number; endX: number }>;
} {
  if (width <= 0) return { text: "", regions: [] };
  const pieces: Array<{ action?: "models" | "thinking" | "workdir"; text: string }> = [];
  let remaining = Math.max(0, width - 2);
  const escapeText = escapeHint ? activeRenderTheme.dim(escapeHint) : "";
  const escapeWidth = visibleWidth(escapeText);
  const thinkingText = ` ✦ ${thinking} `;
  const thinkingWidth = visibleWidth(thinkingText);
  const modelFullWidth = visibleWidth(` 󰚩 ${model} `);
  const fixedWidth = thinkingWidth + escapeWidth + (escapeText ? 1 : 0);
  const modelWidth = Math.max(5, Math.min(modelFullWidth, remaining - fixedWidth));
  const modelText = truncateToWidth(` 󰚩 ${model} `, modelWidth, "...");
  pieces.push({
    action: "models",
    text: activeRenderTheme.accent(activeRenderTheme.bold(modelText)),
  });
  remaining -= visibleWidth(modelText);
  if (remaining >= thinkingWidth + escapeWidth + (escapeText ? 1 : 0)) {
    pieces.push({ text: "  " });
    pieces.push({
      action: "thinking",
      text: activeRenderTheme.accent(activeRenderTheme.bold(thinkingText)),
    });
    remaining -= 2 + thinkingWidth;
  }
  const escapeGap = escapeText ? 1 + escapeWidth : 0;
  const workdirBudget = Math.max(0, remaining - escapeGap - 2);
  if (workdirBudget >= 4) {
    pieces.push({ text: "  " });
    const workdir = truncateToWidth(shortWorkdir(workdirPath), workdirBudget, "...");
    pieces.push({ action: "workdir", text: activeRenderTheme.accent(workdir) });
    remaining -= 2 + visibleWidth(workdir);
  }
  if (escapeText && remaining >= escapeGap) {
    pieces.push({ text: " " });
    pieces.push({ text: escapeText });
  }
  const regions: Array<{
    action: "models" | "thinking" | "workdir";
    startX: number;
    endX: number;
  }> = [];
  let cursor = 1;
  let text = "";
  for (const piece of pieces) {
    const pieceWidth = visibleWidth(piece.text);
    if (piece.action && pieceWidth > 0) {
      regions.push({ action: piece.action, startX: cursor, endX: cursor + pieceWidth - 1 });
    }
    text += piece.text;
    cursor += pieceWidth;
  }
  return { text, regions };
}

function chooseInputMetaRight(
  required: string,
  lineWidth: number,
  candidates: Array<() => string>,
): string {
  const minLeftWidth = 8;
  for (const candidate of candidates) {
    const text = candidate();
    if (visibleWidth(text) + minLeftWidth + 1 <= lineWidth) return text;
  }
  return visibleWidth(required) <= lineWidth ? required : truncateToWidth(required, lineWidth, "...");
}

export function renderWorkingIndicator(
  tab: MixCodeTabInfo,
  width: number,
  now = new Date(),
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderWorkingIndicatorInner(tab, width, now));
}

function renderWorkingIndicatorInner(
  tab: MixCodeTabInfo,
  width: number,
  now = new Date(),
): string[] {
  if (!tab.extensionUi.workingVisible) return [];
  if (tab.status !== "running" && tab.status !== "thinking") {
    if (tab.lastWorkedDurationSeconds === undefined) return [];
    const worked = ` Worked for ${formatDuration(tab.lastWorkedDurationSeconds)}`;
    const clock = formatClockTime(tab.lastWorkedAt);
    const text = clock ? `${worked} · at ${clock}` : worked;
    return [
      padLine(
        activeRenderTheme.dim(text),
        width,
      ),
    ];
  }
  const elapsed = formatElapsed(tab.workingStartedAt, now);
  const detail = isPendingEscapeActive(tab, "abort-agent", now.getTime())
    ? "esc again to interrupt"
    : "esc to interrupt";
  const message = tab.extensionUi.workingMessage?.trim() || "Working";
  const indicator = workingIndicatorFrame(tab, now);
  if (indicator === "") return [];
  const prefix = indicator ? `${indicator} ` : "";
  return [
    padLine(`${prefix}${activeRenderTheme.dim(`${message} (${elapsed} • ${detail})`)}`, width),
  ];
}

function workingIndicatorFrame(tab: MixCodeTabInfo, now: Date): string | undefined {
  const frames = tab.extensionUi.workingIndicatorFrames;
  if (frames === undefined) {
    const startedAt = tab.workingStartedAt ? Date.parse(tab.workingStartedAt) : now.getTime();
    const elapsed = Math.max(
      0,
      now.getTime() - (Number.isFinite(startedAt) ? startedAt : now.getTime()),
    );
    return DEFAULT_WORKING_INDICATOR_FRAMES[
      Math.floor(elapsed / DEFAULT_WORKING_INDICATOR_INTERVAL_MS) %
        DEFAULT_WORKING_INDICATOR_FRAMES.length
    ];
  }
  if (frames.length === 0) return "";
  const interval = Math.max(
    1,
    tab.extensionUi.workingIndicatorIntervalMs ?? DEFAULT_WORKING_INDICATOR_INTERVAL_MS,
  );
  return frames[Math.floor(now.getTime() / interval) % frames.length] ?? "";
}

export function renderExtensionWidgets(
  tab: MixCodeTabInfo,
  width: number,
  placement: "aboveEditor" | "belowEditor",
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderExtensionWidgetsInner(tab, width, placement));
}

function renderExtensionWidgetsInner(
  tab: MixCodeTabInfo,
  width: number,
  placement: "aboveEditor" | "belowEditor",
): string[] {
  const widgets = tab.extensionUi.widgets.filter((widget) => widget.placement === placement);
  if (!widgets.length) return [];
  const lines: string[] = [];
  widgets.forEach((widget) => {
    const bodyWidth = Math.max(1, width - 2);
    const widgetLines = widget.render?.(bodyWidth) ?? wrapExtensionWidgetLines(widget.lines, bodyWidth);
    lines.push(...widgetLines.map((line) => renderSingleLineExtensionSlot(line, width)));
  });
  return lines;
}

function wrapExtensionWidgetLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => wrapTextWithAnsi(sanitizeWidgetLine(line), width));
}

export function renderFooter(width: number): string[] {
  void width;
  return [];
}

export function renderExtensionFooter(tab: MixCodeTabInfo | undefined, width: number): string[] {
  const footer = tab?.extensionUi.footer;
  return renderExtensionComponentSlot(footer?.render ? footer.render(width) : footer?.lines, width);
}

// Build a pi-style extension status line: value-only, space-joined.
// Returns undefined when there are no statuses so the caller can collapse to
// single-line layout.
function buildExtensionStatusLine(
  tab: MixCodeTabInfo,
  width: number,
): string | undefined {
  const statuses = tab.extensionUi.statuses;
  if (!statuses.length) return undefined;
  const sorted = [...statuses].sort((a, b) => a.key.localeCompare(b.key));
  const text = sorted
    .map((status) => cleanStatusText(status.text))
    .filter((t) => t.trim())
    .join(" ");
  if (!text) return undefined;
  return padLine(` ${text}`, width);
}

function renderExtensionComponentSlot(lines: string[] | undefined, width: number): string[] {
  if (!lines?.length) return [];
  return lines.map((line) => padLine(sanitizeWidgetLine(line), width));
}

function renderSingleLineExtensionSlot(line: string, width: number): string {
  const bodyWidth = Math.max(1, width - 2);
  const text = truncateToWidth(sanitizeWidgetLine(line), bodyWidth, "...");
  return padLine(` ${activeRenderTheme.dim(text)}`, width);
}

function cleanStatusText(text: string): string {
  // sanitizeTerminalText is ANSI-aware: it preserves SGR color sequences
  // (ESC + CSI ... m) and drops every other control char. A blanket strip of
  // 0x0e-0x1f here would delete the ESC (0x1b) byte and leak bare "[..m" tokens
  // into the status line, so collapse whitespace only after sanitizing.
  return sanitizeTerminalText(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeWidgetLine(text: string): string {
  return sanitizeTerminalText(text)
    .replace(/[\r\n\t]+/g, " ")
    .trimEnd();
}

function tabBarSegments(state: MixCodeState): Array<{ id: string; text: string }> {
  const configText = " MixCode Home ";
  const isHomeActive = state.activeTabId === "config";
  const config = isHomeActive
    ? activeRenderTheme.homeTabActive(configText)
    : activeRenderTheme.homeTab(configText);
  return [
    { id: "config", text: config },
    ...state.tabs.map((tab) => {
      const status = tabStatusGlyph(tab);
      const text = ` ${status} ${tab.title} `;
      return {
        id: tab.sessionId,
        text: renderTabSegmentText(tab, text, state.activeTabId === tab.sessionId),
      };
    }),
  ];
}

function renderTabSegmentText(tab: MixCodeTabInfo, text: string, active: boolean): string {
  const statusColor = tabHasPendingUserInteraction(tab)
    ? activeRenderTheme.tool
    : tab.status === "running" || tab.status === "thinking"
      ? activeRenderTheme.accent
      : tab.status !== "error" && tab.unreadDone
        ? activeRenderTheme.done
        : undefined;
  const colored = statusColor ? statusColor(text) : text;
  return active ? activeRenderTheme.activeTab(colored) : activeRenderTheme.tab(colored);
}

export function tabStatusGlyph(tab: MixCodeTabInfo): string {
  if (tab.status === "Not Ready") return "◌";
  if (tab.status === "error") return "x";
  if (tabHasPendingUserInteraction(tab)) return "?";
  if (tab.status === "running" || tab.status === "thinking") return "*";
  if (tab.status === "done" || tab.unreadDone) return "!";
  return "-";
}

function shortWorkdir(workdir: string): string {
  const home = process.env.HOME;
  if (home && workdir.startsWith(home)) return `~${workdir.slice(home.length)}`;
  return workdir;
}

function formatElapsed(startedAt: string | undefined, now: Date): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const elapsedSeconds = Number.isFinite(start)
    ? Math.max(0, Math.floor((now.getTime() - start) / 1000))
    : 0;
  return formatDuration(elapsedSeconds);
}

function formatDuration(elapsedSeconds: number): string {
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0)
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Format an ISO stamp as local `YYYY-MM-DD HH:MM:SS`; empty string if absent/invalid. */
function formatClockTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function gitBranchForWorkdir(workdir: string): string {
  const path = workdir.trim();
  if (!path) return "";
  const cached = gitBranchCache.get(path);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  let value = "";
  try {
    value = execFileSync("git", ["branch", "--show-current"], {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    if (!value) {
      value = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: path,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
    }
  } catch {
    value = "";
  }
  gitBranchCache.set(path, { value, expiresAt: now + GIT_BRANCH_CACHE_TTL_MS });
  return value;
}
