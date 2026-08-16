import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { cwd, env as processEnv } from "node:process";
import {
  instanceCtlSocketFile,
  loadLiveInstanceStatus,
  type InstanceStatusInstance,
} from "../core/instance-registry.js";
import { encodeSendKeys } from "./ctl-keys.js";
import { expandTilde, resolveMixcodeStateDir } from "./status.js";

export const CTL_OPS = [
  "last-message",
  "last-assistant-message",
  "last-user-message",
  "last-tool",
  "wait",
  "dump-screen",
  "send-keys",
] as const;
export type CtlOp = (typeof CTL_OPS)[number];

export interface CtlRequest {
  op: CtlOp;
  focusSessionId?: string;
  focusTabTitle?: string;
  /** Encoded stdin chunks; each chunk is one inject() (one send-keys token). */
  keys?: string[];
  /** 1-based from the end; only with last-*-message / last-tool. Pair with `to`. */
  from?: number;
  to?: number;
  /** wait: max seconds (default 60; 0 checks once). */
  timeout?: number;
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
  op: CtlOp;
  keys?: string[];
  from?: number;
  to?: number;
  timeout?: number;
  ansi?: boolean;
  help?: boolean;
}

export const CTL_HELP = `Usage: mpi ctl [--pid <n> | --workdir <path>] [--focus-tab <title> | --focus-session <id>] <command>

Commands:
  last-message            Print the focused tab's last user/assistant text (includes time)
  last-assistant-message  Print the focused tab's last assistant text (includes time)
  last-user-message       Print the focused tab's last user text (includes time)
  last-tool               Print the focused tab's last tool/bash result
  wait                    Block until the focused tab is not running/thinking
  dump-screen             Print the focused tab/home surface as text
  send-keys [-l] [key...] Inject tmux-style keys into the live TUI input path

Target:
  --pid <n>               Control this live instance (mutually exclusive with --workdir)
  --workdir <path>        Control the unique live instance in this workdir (mutually exclusive with --pid)
  (default)               MIXCODE_PID env (bash tool children), else --workdir <cwd>; errors if 0 or >1 instances

  --focus-tab <title>     Focus the tab with this exact title (mutually exclusive with --focus-session)
  --focus-session <id>    Focus this session id, or home for Home
  --from <n> --to <m>     last-*-message / last-tool: 1-based range from the end (both required; 1=newest)
  --timeout <sec>         wait: max seconds (default 60; 0 checks once)
  --ansi                  dump-screen: keep color/escape sequences (default strips them)
  --literal, -l           send-keys: join tokens as literal text (no Enter/C-p mapping)

Output larger than 8192 bytes for last-message, last-assistant-message, last-user-message, last-tool, and
dump-screen is truncated to 4096 bytes on stdout; the full text is written to
/tmp/mpi-ctl-<pid>-<command>-<ms>.txt (mode 0600).
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
  let literal = false;
  let from: number | undefined;
  let to: number | undefined;
  let timeout: number | undefined;
  let ansi = false;
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
    if (arg === "--workdir") {
      const value = args[++index];
      if (!value) throw new Error("--workdir requires a path");
      workdir = path.resolve(baseWorkdir, expandTilde(value));
      continue;
    }
    if (arg?.startsWith("--workdir=")) {
      const value = arg.slice("--workdir=".length);
      if (!value) throw new Error("--workdir requires a path");
      workdir = path.resolve(baseWorkdir, expandTilde(value));
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
    if (arg === "--literal" || arg === "-l") {
      literal = true;
      continue;
    }
    if (arg === "--ansi") {
      ansi = true;
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
  if (focusSessionId !== undefined && focusTabTitle !== undefined) {
    throw new Error("--focus-tab and --focus-session are mutually exclusive");
  }
  const op = rest[0];
  if (!op || !CTL_OPS.includes(op as CtlOp)) {
    throw new Error(
      `Unknown ctl command: ${op ?? "(missing)"}. Use last-message, last-assistant-message, last-user-message, last-tool, wait, dump-screen, or send-keys.`,
    );
  }
  if (op !== "send-keys" && rest.length > 1) {
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
  if (op === "wait" && timeout === undefined) timeout = 60;
  const keys =
    op === "send-keys"
      ? rest.slice(1).map((token) => encodeSendKeys([token], { literal }))
      : undefined;
  return { pid, workdir, focusSessionId, focusTabTitle, op: op as CtlOp, keys, from, to, timeout, ansi };
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

export async function requestCtl(
  socketPath: string,
  request: CtlRequest,
): Promise<CtlResponse> {
  const payload = `${JSON.stringify(request)}\n`;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(10_000, () => socket.destroy(new Error("ctl socket timed out")));
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
  return op !== "send-keys" && op !== "wait";
}

/** Strip CSI/OSC so dump-screen is readable without a TUI import on the ctl fast path. */
export function stripCtlAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "");
}

export function normalizeCtlStdout(text: string, ansi = false): string {
  const body = ansi ? text : stripCtlAnsi(text);
  return body.replace(/[ \t]+$/gm, "");
}

export function sliceUtf8Prefix(text: string, maxBytes: number): string {
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
  return {
    text: `${preview}\n\n[truncated] full output: ${overflowPath} (${bytes} bytes)\n`,
    overflowPath,
  };
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
  const stateDir = options.stateDir ?? resolveMixcodeStateDir();
  const instance = await selectCtlInstance(parsed, { stateDir });
  const response = await requestCtl(instanceCtlSocketFile(stateDir, instance.pid), {
    op: parsed.op,
    focusSessionId: parsed.focusSessionId,
    focusTabTitle: parsed.focusTabTitle,
    keys: parsed.keys,
    from: parsed.from,
    to: parsed.to,
    timeout: parsed.timeout,
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
