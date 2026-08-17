import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { cwd, env as processEnv } from "node:process";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  instanceCtlSocketFile,
  loadLiveInstanceStatus,
  type InstanceStatusInstance,
} from "../core/instance-registry.js";
import { encodeSendKeys } from "./ctl-keys.js";
import { resolveMixcodeStateDir, takeWorkdirFlag } from "./status.js";

export const CTL_OPS = [
  "last-message",
  "last-assistant-message",
  "last-user-message",
  "last-tool",
  "wait",
  "dump-screen",
  "send-keys",
  "send-prompt",
] as const;
export type CtlOp = (typeof CTL_OPS)[number];

export interface CtlRequest {
  op: CtlOp;
  focusSessionId?: string;
  focusTabTitle?: string;
  /** Target without changing UI focus. */
  sessionId?: string;
  tabTitle?: string;
  /** Encoded stdin chunks; each chunk is one inject() (one send-keys token). */
  keys?: string[];
  /** Raw prompt for send-prompt (newlines kept). */
  prompt?: string;
  /** Sender tab title from MIXCODE_TAB_TITLE; used to wrap non-slash submits. */
  fromTabTitle?: string;
  /** send-prompt: ask the target to read mpi-ctl skill and send a result back. */
  expectResponse?: boolean;
  /** 1-based from the end; only with last-*-message / last-tool. Pair with `to`. */
  from?: number;
  to?: number;
  /** wait: max seconds (default 60; 0 checks once). */
  timeout?: number;
  /** dump-screen: render width; overlay still uses a 100-col floor when omitted. */
  width?: number;
}

export interface CtlResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface CtlArgs {
  pid?: number;
  workdir?: string;
  focusSessionId?: string;
  focusTabTitle?: string;
  sessionId?: string;
  tabTitle?: string;
  op: CtlOp;
  keys?: string[];
  prompt?: string;
  promptFromStdin?: boolean;
  from?: number;
  to?: number;
  timeout?: number;
  ansi?: boolean;
  width?: number;
  expectResponse?: boolean;
  help?: boolean;
}

export const CTL_HELP = `Usage: mpi ctl [--pid <n> | --workdir <path>] [--tab <title> | --session <id> | --focus-tab <title> | --focus-session <id>] <command>

Commands:
  last-message            Print the focused tab's last user/assistant text (includes time)
  last-assistant-message  Print the focused tab's last assistant text (includes time)
  last-user-message       Print the focused tab's last user text (includes time)
  last-tool               Print the focused tab's last tool/bash result
  wait                    Block until the focused tab is not running/thinking
  dump-screen             Print the focused tab/home surface as text
  send-keys [-l] [key...] Inject tmux-style keys into the live TUI input path
  send-prompt [text...]   Submit text to the target tab; no text reads stdin (heredoc/pipe)

Target:
  --pid <n>               Control this live instance (mutually exclusive with --workdir)
  --workdir <path>        Control the unique live instance in this workdir (mutually exclusive with --pid)
  (default)               MIXCODE_PID env (bash tool children), else --workdir <cwd>; errors if 0 or >1 instances

  --tab <title>           Target this tab title without changing UI focus
  --session <id>          Target this session id without changing UI focus (home for Home)
  --focus-tab <title>     Target and leave UI focus on this tab title
  --focus-session <id>    Target and leave UI focus on this session id (home for Home)
  --from <n> --to <m>     last-*-message / last-tool: 1-based range from the end (both required; 1=newest)
  --timeout <sec>         wait: max seconds (default 60; 0 checks once)
  --ansi                  dump-screen: keep color/escape sequences (default strips them)
  --width <n>             dump-screen: render width (default: live TUI columns; overlay floor 100)
  --expect-response       send-prompt: ask the target to reply via mpi ctl (requires MIXCODE_TAB_TITLE)
  --literal, -l           send-keys: join tokens as literal text (no Enter/C-p mapping)

Output larger than 8192 bytes for last-message, last-assistant-message, last-user-message, last-tool, and
dump-screen is truncated to 4096 bytes on stdout; the full text is written to
/tmp/mpi-ctl-<pid>-<command>-<ms>.txt (mode 0600). Notice:
[Full output: <path>. Truncated: N lines shown (4.0KB limit)]
`;

export function isCtlCliArgs(args: string[]): boolean {
  return args[0] === "ctl";
}

export function parseCtlArgs(args: string[], fallbackWorkdir: string): CtlArgs {
  const baseWorkdir = path.resolve(fallbackWorkdir);
  let pid: number | undefined;
  let workdir: string | undefined;
  let focusSessionId: string | undefined;
  let focusTabTitle: string | undefined;
  let sessionId: string | undefined;
  let tabTitle: string | undefined;
  let literal = false;
  let from: number | undefined;
  let to: number | undefined;
  let timeout: number | undefined;
  let ansi = false;
  let width: number | undefined;
  let expectResponse = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { op: "last-assistant-message", help: true };
    if (arg === "--pid") {
      const value = args[++index];
      if (!value) throw new Error("--pid requires a number");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --pid: ${value}`);
      pid = parsed;
      continue;
    }
    if (arg?.startsWith("--pid=")) {
      const value = arg.slice("--pid=".length);
      if (!value) throw new Error("--pid requires a number");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --pid: ${value}`);
      pid = parsed;
      continue;
    }
    const parsedWorkdir = takeWorkdirFlag(arg, () => args[++index], baseWorkdir);
    if (parsedWorkdir !== undefined) {
      workdir = parsedWorkdir;
      continue;
    }
    if (arg === "--focus-session") {
      const value = args[++index];
      if (!value) throw new Error("--focus-session requires an id");
      focusSessionId = value;
      continue;
    }
    if (arg?.startsWith("--focus-session=")) {
      const value = arg.slice("--focus-session=".length);
      if (!value) throw new Error("--focus-session requires an id");
      focusSessionId = value;
      continue;
    }
    if (arg === "--focus-tab") {
      const value = args[++index];
      if (!value) throw new Error("--focus-tab requires a title");
      focusTabTitle = value;
      continue;
    }
    if (arg?.startsWith("--focus-tab=")) {
      const value = arg.slice("--focus-tab=".length);
      if (!value) throw new Error("--focus-tab requires a title");
      focusTabTitle = value;
      continue;
    }
    if (arg === "--tab") {
      const value = args[++index];
      if (!value) throw new Error("--tab requires a title");
      tabTitle = value;
      continue;
    }
    if (arg?.startsWith("--tab=")) {
      const value = arg.slice("--tab=".length);
      if (!value) throw new Error("--tab requires a title");
      tabTitle = value;
      continue;
    }
    if (arg === "--session") {
      const value = args[++index];
      if (!value) throw new Error("--session requires an id");
      sessionId = value;
      continue;
    }
    if (arg?.startsWith("--session=")) {
      const value = arg.slice("--session=".length);
      if (!value) throw new Error("--session requires an id");
      sessionId = value;
      continue;
    }
    if (arg === "--literal" || arg === "-l") {
      literal = true;
      continue;
    }
    if (arg === "--ansi") {
      ansi = true;
      continue;
    }
    if (arg === "--expect-response") {
      expectResponse = true;
      continue;
    }
    if (arg === "--width" || arg?.startsWith("--width=")) {
      const value = arg === "--width" ? args[++index] : arg.slice("--width=".length);
      if (!value) throw new Error("--width requires a positive integer");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid --width: ${value}`);
      width = parsed;
      continue;
    }
    if (arg === "--from" || arg?.startsWith("--from=")) {
      const value = arg === "--from" ? args[++index] : arg.slice("--from=".length);
      if (!value) throw new Error("--from requires a positive integer");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid --from: ${value}`);
      from = parsed;
      continue;
    }
    if (arg === "--to" || arg?.startsWith("--to=")) {
      const value = arg === "--to" ? args[++index] : arg.slice("--to=".length);
      if (!value) throw new Error("--to requires a positive integer");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid --to: ${value}`);
      to = parsed;
      continue;
    }
    if (arg === "--timeout" || arg?.startsWith("--timeout=")) {
      const value = arg === "--timeout" ? args[++index] : arg.slice("--timeout=".length);
      if (!value) throw new Error("--timeout requires a non-negative integer");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid --timeout: ${value}`);
      timeout = parsed;
      continue;
    }
    rest.push(arg);
  }
  if (pid !== undefined && workdir !== undefined) {
    throw new Error("--pid and --workdir are mutually exclusive");
  }
  const selectors = [focusSessionId, focusTabTitle, sessionId, tabTitle].filter((value) => value !== undefined);
  if (selectors.length > 1) {
    throw new Error("--tab, --session, --focus-tab, and --focus-session are mutually exclusive");
  }
  const op = rest[0];
  if (!op || !CTL_OPS.includes(op as CtlOp)) {
    throw new Error(
      `Unknown ctl command: ${op ?? "(missing)"}. Use last-message, last-assistant-message, last-user-message, last-tool, wait, dump-screen, send-keys, or send-prompt.`,
    );
  }
  if (op !== "send-keys" && op !== "send-prompt" && rest.length > 1) {
    throw new Error(`Unexpected argument: ${rest[1]}`);
  }
  if ((from === undefined) !== (to === undefined)) {
    throw new Error("--from and --to must be used together");
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error("--from cannot be greater than --to");
  }
  const messageOp =
    op === "last-message" ||
    op === "last-assistant-message" ||
    op === "last-user-message" ||
    op === "last-tool";
  if ((from !== undefined || to !== undefined) && !messageOp) {
    throw new Error("--from/--to only apply to last-message, last-assistant-message, last-user-message, and last-tool");
  }
  if (timeout !== undefined && op !== "wait") {
    throw new Error("--timeout only applies to wait");
  }
  if (literal && op !== "send-keys") {
    throw new Error("--literal only applies to send-keys");
  }
  if (ansi && op !== "dump-screen") {
    throw new Error("--ansi only applies to dump-screen");
  }
  if (width !== undefined && op !== "dump-screen") {
    throw new Error("--width only applies to dump-screen");
  }
  if (expectResponse && op !== "send-prompt") {
    throw new Error("--expect-response only applies to send-prompt");
  }
  if (op === "wait" && timeout === undefined) timeout = 60;
  const keys =
    op === "send-keys"
      ? rest.slice(1).map((token) => encodeSendKeys([token], { literal }))
      : undefined;
  const promptArgs = op === "send-prompt" ? rest.slice(1) : [];
  const promptFromStdin = op === "send-prompt" && (promptArgs.length === 0 || (promptArgs.length === 1 && promptArgs[0] === "-"));
  const prompt = op === "send-prompt" && !promptFromStdin ? promptArgs.join(" ") : undefined;
  return {
    pid,
    workdir,
    focusSessionId,
    focusTabTitle,
    sessionId,
    tabTitle,
    op: op as CtlOp,
    keys,
    prompt,
    promptFromStdin,
    from,
    to,
    timeout,
    ansi,
    width,
    expectResponse: expectResponse || undefined,
  };
}

/** Structural env slice so both `process.env` and test literals satisfy it. */
type MixCodePidEnv = Record<string, string | undefined>;

/** Read MIXCODE_PID; unset falls back to workdir matching, while invalid values fail explicitly. */
function mixcodePidFromEnv(env: MixCodePidEnv = processEnv): number | undefined {
  const raw = env.MIXCODE_PID;
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  const pid = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Invalid MIXCODE_PID; expected a positive integer.");
  }
  return pid;
}

export async function selectCtlInstance(
  args: CtlArgs,
  options: { stateDir?: string; now?: Date; env?: MixCodePidEnv } = {},
): Promise<InstanceStatusInstance> {
  const stateDir = options.stateDir ?? resolveMixcodeStateDir();
  // Target precedence: explicit --pid/--workdir > MIXCODE_PID env > cwd workdir.
  const envPid = args.pid || args.workdir ? undefined : mixcodePidFromEnv(options.env);
  const pid = args.pid ?? envPid;
  const report = await loadLiveInstanceStatus(stateDir, {
    workdir: pid ? undefined : (args.workdir ?? path.resolve(cwd())),
    now: options.now,
  });
  let instances = report.instances;
  if (pid) instances = instances.filter((instance) => instance.pid === pid);
  if (instances.length === 0) {
    throw new Error(
      envPid !== undefined
        ? `No live mpi instance matches MIXCODE_PID=${envPid}; unset it or pass --pid/--workdir.`
        : "No live mpi instance matches the target.",
    );
  }
  if (instances.length > 1) {
    throw new Error(
      `Multiple live mpi instances match (${instances.map((i) => i.pid).join(", ")}); pass --pid.`,
    );
  }
  return instances[0]!;
}

export const CTL_CLIENT_IDLE_TIMEOUT_MS = 10_000;
export const CTL_CLIENT_WAIT_SLACK_SEC = 5;

/** Client socket deadline. `wait` must outlive `--timeout`; other ops stay at 10s. */
export function ctlClientTimeoutMs(request: Pick<CtlRequest, "op" | "timeout">): number {
  if (request.op === "wait") {
    return ((request.timeout ?? 60) + CTL_CLIENT_WAIT_SLACK_SEC) * 1000;
  }
  return CTL_CLIENT_IDLE_TIMEOUT_MS;
}

export async function requestCtl(
  socketPath: string,
  request: CtlRequest,
): Promise<CtlResponse> {
  const payload = `${JSON.stringify(request)}\n`;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(ctlClientTimeoutMs(request), () => socket.destroy(new Error("ctl socket timed out")));
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as CtlResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!buf.includes("\n")) reject(new Error("ctl socket closed without a response"));
    });
  });
}

export const CTL_STDOUT_LIMIT_BYTES = 8192;
export const CTL_STDOUT_PREVIEW_BYTES = 4096;

export function shouldTruncateCtlOutput(op: CtlOp): boolean {
  return op !== "send-keys" && op !== "send-prompt" && op !== "wait";
}

export function normalizeCtlStdout(text: string, ansi = false): string {
  const body = ansi ? text : stripTerminalSequences(text);
  return body.replace(/[ \t]+$/gm, "");
}

function formatCtlSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sliceUtf8Prefix(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const unit of text) {
    const size = encoder.encode(unit).byteLength;
    if (used + size > maxBytes) break;
    out += unit;
    used += size;
  }
  return out;
}

export async function truncateCtlStdout(
  text: string,
  options: { op: CtlOp; pid: number; tmpDir?: string; now?: number },
): Promise<{ text: string; overflowPath?: string }> {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes <= CTL_STDOUT_LIMIT_BYTES) return { text };
  const overflowPath = path.join(
    options.tmpDir ?? os.tmpdir(),
    `mpi-ctl-${options.pid}-${options.op}-${options.now ?? Date.now()}.txt`,
  );
  // "wx" refuses pre-planted files; 0600 at creation closes the exposure window.
  const handle = await fs.open(overflowPath, "wx", 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  const preview = sliceUtf8Prefix(text, CTL_STDOUT_PREVIEW_BYTES);
  const linesShown = preview.length === 0 ? 0 : preview.split("\n").length;
  return {
    text: `${preview}\n\n[Full output: ${overflowPath}. Truncated: ${linesShown} lines shown (${formatCtlSize(CTL_STDOUT_PREVIEW_BYTES)} limit)]\n`,
    overflowPath,
  };
}

export async function resolveSendPromptText(
  parsed: Pick<CtlArgs, "prompt" | "promptFromStdin">,
  options: { isTTY?: boolean; readStdin?: () => Promise<string> } = {},
): Promise<string> {
  if (!parsed.promptFromStdin) {
    if (!parsed.prompt) throw new Error("send-prompt requires text");
    return parsed.prompt;
  }
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (isTTY) {
    throw new Error("send-prompt: no text on argv; pass arguments or a heredoc/pipe (stdin is a TTY)");
  }
  const text = options.readStdin ? await options.readStdin() : await Bun.stdin.text();
  if (!text) throw new Error("send-prompt requires text");
  return text;
}

export async function runCtlCommand(
  rawArgs: string[],
  options: { fallbackWorkdir?: string; stateDir?: string } = {},
): Promise<void> {
  const parsed = parseCtlArgs(rawArgs, options.fallbackWorkdir ?? cwd());
  if (parsed.help) {
    process.stdout.write(`${CTL_HELP}\n`);
    return;
  }
  const prompt =
    parsed.op === "send-prompt" ? await resolveSendPromptText(parsed) : parsed.prompt;
  const fromTabTitle = process.env.MIXCODE_TAB_TITLE?.trim() || undefined;
  if (parsed.expectResponse && !fromTabTitle) {
    throw new Error("send-prompt --expect-response requires MIXCODE_TAB_TITLE");
  }
  const stateDir = options.stateDir ?? resolveMixcodeStateDir();
  const instance = await selectCtlInstance(parsed, { stateDir });
  const response = await requestCtl(instanceCtlSocketFile(stateDir, instance.pid), {
    op: parsed.op,
    focusSessionId: parsed.focusSessionId,
    focusTabTitle: parsed.focusTabTitle,
    sessionId: parsed.sessionId,
    tabTitle: parsed.tabTitle,
    keys: parsed.keys,
    prompt,
    fromTabTitle,
    expectResponse: parsed.expectResponse,
    from: parsed.from,
    to: parsed.to,
    timeout: parsed.timeout,
    width: parsed.width,
  });
  if (response.text) {
    const text = normalizeCtlStdout(response.text, parsed.ansi === true);
    const printed = shouldTruncateCtlOutput(parsed.op)
      ? (await truncateCtlStdout(text, { op: parsed.op, pid: instance.pid })).text
      : text;
    process.stdout.write(printed.endsWith("\n") ? printed : `${printed}\n`);
  }
  if (!response.ok) throw new Error(response.error ?? "ctl request failed");
}
