import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { resolveMixcodeAgentDir } from "./paths.js";
import type { CtlRequest, CtlResponse } from "../cli/ctl.js";
import { renderSessionActionConfirm } from "../ui/app-overlays.js";
import { renderAgentSurface } from "../ui/rendering/agent-surface.js";
import { renderHome, renderPickerOverlay } from "../ui/rendering/overlays.js";
import { getSessionSelectorComponent } from "../ui/session-resume.js";
import { getSettingsPanelComponent } from "../ui/components/settings-panel.js";
import { themeForId } from "../ui/themes.js";
import { activateTab, getActiveTab } from "./tabs.js";
import { tabIsWaitingForInput } from "./tab-state.js";
import { isInstanceOverlayOpen, tabOwnsWaitingAppOverlay } from "./overlays.js";
import { HOME_TAB_ID, type MixCodeState, type MixCodeTabInfo } from "./types.js";
import { instanceCtlSocketFile, instanceRegistryDir } from "./instance-registry.js";

export interface InstanceCtlServer {
  socketPath: string;
  dispose(): void;
}

export interface StartInstanceCtlServerOptions {
  rootStateDir: string;
  pid?: number;
  state: MixCodeState;
  runtime: MixCodeRuntime;
  injectInput: (data: string) => void;
  /** Submit text to a tab without changing UI focus (Home-send path). */
  submitToTab?: (tab: MixCodeTabInfo, text: string) => void | Promise<void>;
  requestRender?: () => void;
  screenWidth?: () => number;
  /** Focused-tab dump: live TUI children (chrome + editor slot). Overlays are appended separately. */
  renderTui?: (width: number) => string[];
  /** MixCode showLinesOverlay / showComponentOverlay is open. */
  hasAppOverlay?: () => boolean;
  renderAppOverlay?: (width: number) => string[];
  /** Drive a tab-owned overlay without changing UI focus. */
  dispatchTabOverlayKeys?: (tab: MixCodeTabInfo, data: string) => boolean;
  /**
   * Async socket failures (e.g. bind errors after `listen` returns). Without
   * this hook an unhandled 'error' event would kill the whole process.
   */
  onError?: (error: Error) => void;
}

export function resolveCtlFocusSessionId(
  state: MixCodeState,
  request: Pick<CtlRequest, "focusSessionId" | "focusTabTitle" | "sessionId" | "tabTitle">,
): string {
  const sessionKey = request.focusSessionId ?? request.sessionId;
  if (sessionKey) {
    if (sessionKey === HOME_TAB_ID) return HOME_TAB_ID;
    if (!state.tabs.some((tab) => tab.sessionId === sessionKey)) {
      throw new Error(`Unknown session: ${sessionKey}`);
    }
    return sessionKey;
  }
  const titleKey = request.focusTabTitle ?? request.tabTitle;
  if (titleKey) {
    const matches = state.tabs.filter((tab) => tab.title === titleKey);
    if (matches.length === 0) throw new Error(`Unknown tab title: ${titleKey}`);
    if (matches.length > 1) {
      throw new Error(`Multiple tabs titled '${titleKey}'; pass --session or --focus-session`);
    }
    return matches[0]!.sessionId;
  }
  return state.activeTabId;
}

export const IMPLIED_FOCUS_REASON =
  "no --tab/--session/--focus-tab/--focus-session; using live UI focus";
export const CTL_MESSAGE_DIVIDER = "----------";
export const CTL_WAIT_DEFAULT_TIMEOUT_SEC = 60;
const CTL_WAIT_POLL_MS = 50;
const CTL_WAIT_BUSY = new Set(["running", "thinking"]);

function formatCtlPreamble(
  tabTitle: string,
  sessionId: string,
  extras: { reason?: string; time?: string; messages?: string } = {},
): string {
  const lines = [`tab: ${tabTitle}`, `session: ${sessionId}`];
  if (extras.reason) lines.push(`reason: ${extras.reason}`);
  if (extras.messages) lines.push(`messages: ${extras.messages}`);
  if (extras.time) lines.push(`time: ${extras.time}`);
  return `${lines.join("\n")}\n\n`;
}

export function formatCtlTime(timestamp?: number): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "unknown";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
  ].join(" ");
}

function ctlTabTitle(state: MixCodeState, sessionId: string): string {
  if (sessionId === HOME_TAB_ID) return "home";
  return state.tabs.find((tab) => tab.sessionId === sessionId)?.title ?? sessionId;
}

function withPreamble(
  request: CtlRequest,
  state: MixCodeState,
  sessionId: string,
  body: string,
  extras: { time?: string; messages?: string } = {},
): string {
  const implied =
    !request.focusSessionId && !request.focusTabTitle && !request.sessionId && !request.tabTitle;
  return `${formatCtlPreamble(ctlTabTitle(state, sessionId), sessionId, {
    reason: implied ? IMPLIED_FOCUS_REASON : undefined,
    time: extras.time,
    messages: extras.messages,
  })}${body}`;
}

export const CTL_DUMP_OVERLAY_MIN_WIDTH = 100;

export function resolveCtlDumpWidths(
  requestWidth: number | undefined,
  liveWidth: number,
): { dumpWidth: number; overlayWidth: number } {
  const dumpWidth = Math.max(20, requestWidth ?? liveWidth);
  const overlayWidth = Math.max(20, requestWidth ?? Math.max(liveWidth, CTL_DUMP_OVERLAY_MIN_WIDTH));
  return { dumpWidth, overlayWidth };
}

function renderCtlOverlayDump(
  runtimeTab: { extensionCustomOverlayComponents?: Iterable<{ render: (width: number) => string[] }> } | undefined,
  width: number,
): string[] {
  if (!runtimeTab?.extensionCustomOverlayComponents) return [];
  const lines: string[] = [];
  for (const component of runtimeTab.extensionCustomOverlayComponents) {
    lines.push(...component.render(width));
  }
  return lines;
}

function renderOwnedAppOverlayDump(state: MixCodeState, sessionId: string, width: number): string[] {
  const lines: string[] = [];
  if (state.picker?.ownerSessionId === sessionId) {
    lines.push(...renderPickerOverlay(state, width));
  }
  const confirm = state.sessionActionConfirm;
  if (confirm?.sessionId === sessionId) {
    const tab = state.tabs.find((item) => item.sessionId === sessionId);
    if (tab) {
      lines.push(
        ...renderSessionActionConfirm(width, themeForId(state.theme), confirm.action, tab.title),
      );
    }
  }
  if (state.sessionSelector.open && state.sessionSelector.ownerSessionId === sessionId) {
    const selector = getSessionSelectorComponent(state);
    if (selector) lines.push(...selector.render(width));
  }
  if (state.settingsPanel.open && state.settingsPanel.ownerSessionId === sessionId) {
    const panel = getSettingsPanelComponent(state);
    if (panel) lines.push(...panel.render(width));
  }
  return lines;
}

export function mpiCtlSkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    resolveMixcodeAgentDir(env),
    "extensions",
    "mpi-ctl",
    "skills",
    "mpi-ctl",
    "SKILL.md",
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function wrapCtlSubmitText(
  text: string,
  fromTabTitle?: string,
  expectResponse = false,
  fromPid?: number,
): string {
  const title = fromTabTitle?.trim();
  const trimmed = text.trimStart();
  const isCommand = trimmed.startsWith("/") || trimmed.startsWith("!");
  if (expectResponse) {
    if (!title) throw new Error("send-prompt --expect-response requires MIXCODE_TAB_TITLE");
    if (isCommand) throw new Error("send-prompt --expect-response does not apply to / or ! lines");
  }
  if (!title || isCommand) return text;
  const senderLabel = fromPid ? `${title}, pid ${fromPid}` : title;
  const origin = `This prompt came from another MixCode tab (${senderLabel}) via \`mpi ctl\`, not from the human user.`;
  if (!expectResponse) return `${origin}\n\n${text}`;
  const target = fromPid ? `--pid ${fromPid} --tab ${shellSingleQuote(title)}` : `--tab ${shellSingleQuote(title)}`;
  return [
    origin,
    "When finished, follow the mpi-ctl skill at:",
    mpiCtlSkillPath(),
    "Send your result back with `mpi ctl`:",
    `mpi ctl ${target} send-prompt <<'EOF'`,
    "<your result>",
    "EOF",
    "Do not pass --expect-response on that reply.",
    "",
    text,
  ].join("\n");
}

const pendingCtlSubmits = new WeakMap<MixCodeTabInfo, number>();

function trackCtlSubmit(
  tab: MixCodeTabInfo,
  work: Promise<unknown>,
  options: Pick<StartInstanceCtlServerOptions, "runtime" | "requestRender">,
): void {
  pendingCtlSubmits.set(tab, (pendingCtlSubmits.get(tab) ?? 0) + 1);
  void work.then(
    () => finishCtlSubmit(tab),
    (error: unknown) => {
      reportCtlSubmitFailure(tab, error, options);
      finishCtlSubmit(tab);
    },
  );
}

/**
 * The ctl client already got its ACK, so a failed submit has no response
 * channel left; the tab's chat surface is the only place a caller can still
 * observe it (`mpi ctl dump-screen`). Staying silent here reports a slash
 * command that threw (unknown model, bad usage) as success.
 */
function reportCtlSubmitFailure(
  tab: MixCodeTabInfo,
  error: unknown,
  options: Pick<StartInstanceCtlServerOptions, "runtime" | "requestRender">,
): void {
  // A tab whose runtime was torn down (closed mid-submit) has no chat to append to.
  if (!options.runtime.getTab(tab.sessionId)) return;
  options.runtime.appendSystemMessage(
    tab.sessionId,
    error instanceof Error ? error.message : String(error),
    "error",
  );
  options.requestRender?.();
}

function finishCtlSubmit(tab: MixCodeTabInfo): void {
  const next = (pendingCtlSubmits.get(tab) ?? 1) - 1;
  if (next <= 0) pendingCtlSubmits.delete(tab);
  else pendingCtlSubmits.set(tab, next);
}

function hasPendingCtlSubmit(tab: MixCodeTabInfo): boolean {
  return (pendingCtlSubmits.get(tab) ?? 0) > 0;
}

function tabIsWaitingForOverlay(
  tab: MixCodeTabInfo,
  options: Pick<StartInstanceCtlServerOptions, "hasAppOverlay" | "state">,
): boolean {
  if (tabOwnsWaitingAppOverlay(options.state, tab.sessionId) || tabIsWaitingForInput(tab)) return true;
  if (isInstanceOverlayOpen(options.state)) return true;
  return options.hasAppOverlay?.() === true && options.state.activeTabId === tab.sessionId;
}

function isCtlWaitSettled(
  tab: MixCodeTabInfo,
  options: Pick<StartInstanceCtlServerOptions, "hasAppOverlay" | "state">,
): boolean {
  return (
    tabIsWaitingForOverlay(tab, options) ||
    (!CTL_WAIT_BUSY.has(tab.status) && !hasPendingCtlSubmit(tab))
  );
}

function isBackgroundSendKeysText(chunk: string): boolean {
  for (let index = 0; index < chunk.length; index++) {
    if (chunk.charCodeAt(index) < 32) return false;
  }
  return true;
}

function tabHasDriveableOverlay(
  tab: MixCodeTabInfo,
  options: Pick<StartInstanceCtlServerOptions, "state" | "runtime">,
): boolean {
  if (tabOwnsWaitingAppOverlay(options.state, tab.sessionId)) return true;
  if (tabIsWaitingForInput(tab)) return true;
  if (isInstanceOverlayOpen(options.state)) return true;
  return options.runtime.hasExtensionCustomOverlay?.(tab.sessionId) === true;
}

function assertBackgroundSendKeys(
  tab: MixCodeTabInfo,
  keys: string[],
  options: Pick<StartInstanceCtlServerOptions, "submitToTab" | "state" | "runtime" | "dispatchTabOverlayKeys">,
): void {
  let needsSubmit = false;
  let needsOverlay = false;
  for (const chunk of keys) {
    if (chunk === "\r" || chunk === "\n") {
      needsSubmit = true;
      continue;
    }
    if (!isBackgroundSendKeysText(chunk)) needsOverlay = true;
  }
  if (tabHasDriveableOverlay(tab, options) && options.dispatchTabOverlayKeys) return;
  if (needsOverlay) {
    throw new Error("send-keys --tab/--session only supports text and Enter; use --focus-tab for UI keys");
  }
  if (needsSubmit && !options.submitToTab) {
    throw new Error("send-keys --tab/--session requires submitToTab");
  }
}

async function applyBackgroundSendKeys(
  tab: MixCodeTabInfo,
  keys: string[],
  options: Pick<
    StartInstanceCtlServerOptions,
    "submitToTab" | "requestRender" | "state" | "runtime" | "dispatchTabOverlayKeys"
  >,
  fromTabTitle?: string,
  fromPid?: number,
): Promise<void> {
  if (tabHasDriveableOverlay(tab, options) && options.dispatchTabOverlayKeys) {
    for (const chunk of keys) {
      if (!options.dispatchTabOverlayKeys(tab, chunk)) {
        throw new Error("send-keys --tab/--session only supports text and Enter; use --focus-tab for UI keys");
      }
    }
    return;
  }
  let pending = "";
  for (const chunk of keys) {
    if (chunk === "\r" || chunk === "\n") {
      await options.submitToTab!(tab, wrapCtlSubmitText(pending, fromTabTitle, false, fromPid));
      pending = "";
      continue;
    }
    pending += chunk;
  }
  if (pending) {
    tab.draftInput = `${tab.draftInput}${pending}`;
    options.requestRender?.();
  }
}

function lastChatMessages(
  runtime: MixCodeRuntime,
  sessionId: string,
  role: "user" | "assistant" | undefined,
  from = 1,
  to = 1,
): { role: "user" | "assistant"; text: string; timestamp?: number }[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > to) {
    throw new Error(`Invalid message range: from=${from}, to=${to} (expected 1-based, from <= to)`);
  }
  const runtimeTab = runtime.getTab(sessionId);
  if (!runtimeTab) throw new Error(`Unknown session: ${sessionId}`);
  const chronological: { role: "user" | "assistant"; text: string; timestamp?: number }[] = [];
  for (const line of runtimeTab.chat) {
    if ((line.role !== "user" && line.role !== "assistant") || !line.text.trim()) continue;
    if (role && line.role !== role) continue;
    chronological.push({
      role: line.role,
      text: line.text,
      timestamp: line.timestamp ?? lastSessionTimestamp(runtimeTab, line.role),
    });
  }
  if (chronological.length === 0) {
    throw new Error(
      role === "assistant" ? "No assistant message yet" : role === "user" ? "No user message yet" : "No message yet",
    );
  }
  const n = chronological.length;
  const start = Math.max(0, n - to);
  const end = Math.min(n - 1, n - from);
  if (start > end) return [];
  return chronological.slice(start, end + 1);
}

function lastChatTools(
  runtime: MixCodeRuntime,
  sessionId: string,
  from = 1,
  to = 1,
): { title: string; status: string; text: string; command?: string; timestamp?: number }[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > to) {
    throw new Error(`Invalid tool range: from=${from}, to=${to} (expected 1-based, from <= to)`);
  }
  const runtimeTab = runtime.getTab(sessionId);
  if (!runtimeTab) throw new Error(`Unknown session: ${sessionId}`);
  const chronological: { title: string; status: string; text: string; command?: string; timestamp?: number }[] =
    [];
  for (const line of runtimeTab.chat) {
    if (line.role !== "tool") continue;
    const command =
      line.args &&
      typeof line.args === "object" &&
      line.args !== null &&
      "command" in line.args &&
      typeof (line.args as { command?: unknown }).command === "string"
        ? (line.args as { command: string }).command
        : undefined;
    const resultText =
      line.toolResult?.content
        ?.map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
        .join("") ?? "";
    chronological.push({
      title: line.title || "unknown",
      status: line.status ?? "unknown",
      text: line.text.trim() ? line.text : resultText,
      command,
      timestamp: line.timestamp,
    });
  }
  if (chronological.length === 0) throw new Error("No tool yet");
  const n = chronological.length;
  const start = Math.max(0, n - to);
  const end = Math.min(n - 1, n - from);
  if (start > end) return [];
  return chronological.slice(start, end + 1);
}

function ctlWaitStatus(
  tab: MixCodeTabInfo,
  options: Pick<StartInstanceCtlServerOptions, "hasAppOverlay" | "state">,
): string {
  if (tabIsWaitingForOverlay(tab, options)) return "wait-for-input";
  if (CTL_WAIT_BUSY.has(tab.status)) return tab.status;
  if (hasPendingCtlSubmit(tab)) return "running";
  if (tab.status === "idle" || tab.status === "done") return "finished";
  return tab.status;
}

async function waitForTabIdle(
  tab: MixCodeTabInfo,
  timeoutSec: number,
  options: Pick<StartInstanceCtlServerOptions, "hasAppOverlay" | "state">,
): Promise<{ status: string; timedOut: boolean }> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (isCtlWaitSettled(tab, options)) {
      return { status: ctlWaitStatus(tab, options), timedOut: false };
    }
    if (timeoutSec === 0 || Date.now() >= deadline) {
      return { status: ctlWaitStatus(tab, options), timedOut: true };
    }
    await Bun.sleep(CTL_WAIT_POLL_MS);
  }
}

function lastSessionTimestamp(
  runtimeTab: { agentSession?: { messages?: Array<{ role: string; timestamp?: number }> } },
  role: "user" | "assistant",
): number | undefined {
  const messages = runtimeTab.agentSession?.messages;
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === role && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
      return message.timestamp;
    }
  }
  return undefined;
}

export async function handleCtlRequest(
  request: CtlRequest,
  options: Omit<StartInstanceCtlServerOptions, "rootStateDir" | "pid">,
): Promise<CtlResponse> {
  try {
    const sessionId = resolveCtlFocusSessionId(options.state, request);
    const stealFocus = Boolean(request.focusSessionId || request.focusTabTitle);
    const targetWithoutFocus = Boolean(request.sessionId || request.tabTitle);
    if (stealFocus && sessionId !== options.state.activeTabId) {
      activateTab(options.state, sessionId);
      options.requestRender?.();
    }
    if (sessionId !== HOME_TAB_ID) {
      const target = options.state.tabs.find((tab) => tab.sessionId === sessionId);
      if (target?.status === "Not Ready") {
        throw new Error("Tab is still loading extensions. Please wait a moment.");
      }
    }
    const wrap = (body: string, extras?: { time?: string; messages?: string }) =>
      withPreamble(request, options.state, sessionId, body, extras);
    if (request.op === "send-prompt") {
      if (request.prompt === undefined) throw new Error("send-prompt requires text");
      if (sessionId === HOME_TAB_ID) throw new Error("Home has no agent run");
      const tab = options.state.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (!tab) throw new Error(`Unknown session: ${sessionId}`);
      if (!options.submitToTab) throw new Error("send-prompt requires submitToTab");
      trackCtlSubmit(
        tab,
        Promise.resolve(
          options.submitToTab(
            tab,
            wrapCtlSubmitText(request.prompt, request.fromTabTitle, request.expectResponse === true, request.fromPid),
          ),
        ),
        options,
      );
      return { ok: true, text: wrap("") };
    }
    if (request.op === "send-keys") {
      if (!request.keys) throw new Error("send-keys requires keys");
      if (targetWithoutFocus) {
        if (sessionId === HOME_TAB_ID) throw new Error("Home has no agent run");
        const tab = options.state.tabs.find((candidate) => candidate.sessionId === sessionId);
        if (!tab) throw new Error(`Unknown session: ${sessionId}`);
        assertBackgroundSendKeys(tab, request.keys, options);
        // ACK before submitToTab finishes; the client idle timeout must not wait on the agent turn.
        const work = applyBackgroundSendKeys(tab, request.keys, options, request.fromTabTitle, request.fromPid);
        const submitsPrompt =
          !tabHasDriveableOverlay(tab, options) &&
          request.keys.some((chunk) => chunk === "\r" || chunk === "\n");
        if (submitsPrompt) {
          trackCtlSubmit(tab, work, options);
        } else {
          void work.catch(() => {
            // draft/overlay update failed after ACK; no ctl response channel left.
          });
        }
      } else {
        for (const chunk of request.keys) options.injectInput(chunk);
      }
      return { ok: true, text: wrap("") };
    }
    if (
      request.op === "last-message" ||
      request.op === "last-assistant-message" ||
      request.op === "last-user-message"
    ) {
      const role =
        request.op === "last-assistant-message"
          ? "assistant"
          : request.op === "last-user-message"
            ? "user"
            : undefined;
      if (sessionId === HOME_TAB_ID) {
        return {
          ok: false,
          text: wrap(""),
          error:
            role === "assistant"
              ? "Home has no assistant message"
              : role === "user"
                ? "Home has no user message"
                : "Home has no message",
        };
      }
      const from = request.from ?? 1;
      const to = request.to ?? 1;
      const selected = lastChatMessages(options.runtime, sessionId, role, from, to);
      const body = selected
        .map((message) => {
          const roleLine = role ? "" : `role: ${message.role}\n`;
          return `${CTL_MESSAGE_DIVIDER}\n${roleLine}time: ${formatCtlTime(message.timestamp)}\n${message.text}`;
        })
        .join("\n");
      const requested = request.from !== undefined || request.to !== undefined;
      const span = to - from + 1;
      const messages =
        requested && selected.length !== span ? `${selected.length} (requested ${from}-${to})` : undefined;
      return { ok: true, text: wrap(body === "" ? "" : `${body}\n`, { messages }) };
    }
    if (request.op === "last-tool") {
      if (sessionId === HOME_TAB_ID) {
        return { ok: false, text: wrap(""), error: "Home has no tool" };
      }
      const from = request.from ?? 1;
      const to = request.to ?? 1;
      const selected = lastChatTools(options.runtime, sessionId, from, to);
      const body = selected
        .map((tool) => {
          const commandLine = tool.command ? `command: ${tool.command}\n` : "";
          return `${CTL_MESSAGE_DIVIDER}\ntool: ${tool.title}\nstatus: ${tool.status}\n${commandLine}time: ${formatCtlTime(tool.timestamp)}\n${tool.text}`;
        })
        .join("\n");
      const requested = request.from !== undefined || request.to !== undefined;
      const span = to - from + 1;
      const messages =
        requested && selected.length !== span ? `${selected.length} (requested ${from}-${to})` : undefined;
      return { ok: true, text: wrap(body === "" ? "" : `${body}\n`, { messages }) };
    }
    if (request.op === "wait") {
      if (sessionId === HOME_TAB_ID) {
        return { ok: false, text: wrap(""), error: "Home has no agent run" };
      }
      const tab = options.state.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (!tab) throw new Error(`Unknown session: ${sessionId}`);
      const timeout = request.timeout ?? CTL_WAIT_DEFAULT_TIMEOUT_SEC;
      const result = await waitForTabIdle(tab, timeout, options);
      const body = `status: ${result.status}\ntimeout: ${timeout}\n`;
      if (result.timedOut) {
        return {
          ok: false,
          text: wrap(body),
          error: `Timed out after ${timeout}s (status: ${result.status})`,
        };
      }
      return { ok: true, text: wrap(body) };
    }
    if (request.op === "dump-screen") {
      const liveWidth = Math.max(20, options.screenWidth?.() ?? process.stdout.columns ?? 80);
      const { dumpWidth, overlayWidth } = resolveCtlDumpWidths(request.width, liveWidth);
      // --tab/--session always dump that tab's surface. Live TUI chrome is only
      // for implied focus / --focus-* (otherwise a focused --tab leaks the workspace).
      const useLiveTui =
        Boolean(options.renderTui) &&
        sessionId === options.state.activeTabId &&
        !request.tabTitle &&
        !request.sessionId;
      const base =
        useLiveTui
          ? options.renderTui!(dumpWidth)
          : sessionId === HOME_TAB_ID
            ? renderHome(options.state, dumpWidth)
            : (() => {
                const tab =
                  options.state.tabs.find((candidate) => candidate.sessionId === sessionId) ??
                  (sessionId === options.state.activeTabId
                    ? getActiveTab(options.state)
                    : undefined);
                if (!tab) throw new Error(`Unknown session: ${sessionId}`);
                return renderAgentSurface(tab, options.runtime.getTab(sessionId), dumpWidth);
              })();
      const ownedOverlay = renderOwnedAppOverlayDump(options.state, sessionId, overlayWidth);
      const includeLiveOverlay =
        options.state.activeTabId === sessionId &&
        !tabOwnsWaitingAppOverlay(options.state, sessionId);
      const overlay = [
        ...renderCtlOverlayDump(options.runtime.getTab(sessionId), overlayWidth),
        ...ownedOverlay,
        ...(includeLiveOverlay ? (options.renderAppOverlay?.(overlayWidth) ?? []) : []),
      ];
      const body = overlay.length === 0 ? base.join("\n") : `${base.join("\n")}\n${overlay.join("\n")}`;
      return { ok: true, text: wrap(body) };
    }
    throw new Error(`Unknown ctl op: ${(request as { op: string }).op}`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function startInstanceCtlServer(options: StartInstanceCtlServerOptions): InstanceCtlServer {
  const pid = options.pid ?? process.pid;
  const socketPath = instanceCtlSocketFile(options.rootStateDir, pid);
  fs.mkdirSync(instanceRegistryDir(options.rootStateDir), { recursive: true });
  fs.rmSync(socketPath, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let request: CtlRequest;
      try {
        request = JSON.parse(buf.slice(0, nl)) as CtlRequest;
        buf = buf.slice(nl + 1);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        return;
      }
      void handleCtlRequest(request, options).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  });
  // Bind failures (EADDRINUSE, EACCES, NFS hiccups) surface asynchronously.
  // Without a handler the 'error' event would kill the whole TUI process.
  server.on("error", (error) => options.onError?.(error));
  // Socket mode 0600 after bind. Do not process.umask(): it is process-global and
  // poisons concurrent mkdir (sessions dirs lose +x) until the listen callback.
  // Parent rootStateDir is 0700, so the bind→chmod window is not world-reachable.
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
  });
  return {
    socketPath,
    dispose() {
      for (const socket of sockets) socket.destroy();
      server.close();
      fs.rmSync(socketPath, { force: true });
    },
  };
}
