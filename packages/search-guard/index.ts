import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * High-cardinality directories that must never be used as search roots.
 * Searching these recursively is prohibitively slow.
 *
 * In addition to the static list, we dynamically add:
 * - homedir()        e.g. /nfs/home/alice
 * - dirname(homedir()) e.g. /nfs/home  (covers non-standard home prefixes)
 */
const home = homedir();
const BLACKLIST: ReadonlySet<string> = new Set([
  "/",
  "/home",
  "/etc",
  "/usr",
  "/var",
  "/tmp",
  "/opt",
  "/nfs",
  home,
  dirname(home),
]);

/** Return true if the resolved path is in the blacklist. */
function isBlacklisted(path: string, cwd: string): boolean {
  return BLACKLIST.has(resolve(cwd, expandTilde(path)));
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return homedir() + p.slice(1);
  }
  return p;
}

/**
 * Inspect a bash command for dangerous search invocations.
 * Returns the offending path, or null if safe.
 */
export function inspectBashCommand(command: string, cwd: string): string | null {
  // Split compound commands on pipe/semicolon/&&/||
  for (const segment of command.split(/[|;&]/)) {
    const result = checkSegment(segment.trim(), cwd);
    if (result) return result;
  }
  return null;
}

const SEARCH_CMDS = new Set(["grep", "rg", "find", "fd", "ag", "ack"]);

// Flags that consume the next token as a value (grep/rg family)
const FLAGS_WITH_VALUE = new Set([
  "-e", "-f", "--include", "--exclude", "--exclude-dir",
  "-m", "--max-count", "-A", "-B", "-C", "--context",
  "--color", "--colours", "-g", "--glob", "-t", "--type",
]);

function checkSegment(segment: string, cwd: string): string | null {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return null;

  // Skip leading env assignments and sudo
  let i = 0;
  while (i < tokens.length && (tokens[i].includes("=") || tokens[i] === "sudo" || tokens[i] === "env")) {
    i++;
  }
  if (i >= tokens.length) return null;

  const cmd = basename(tokens[i]);
  if (!SEARCH_CMDS.has(cmd)) return null;

  const args = tokens.slice(i + 1);
  if (cmd === "find") return checkFindPath(args, cwd);
  if (cmd === "fd") return checkGrepPath(args, cwd); // fd: pattern then path
  return checkGrepPath(args, cwd);
}

/** For find/fd: first non-flag positional is the search root. */
function checkFindPath(args: string[], cwd: string): string | null {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    return isBlacklisted(arg, cwd) ? arg : null;
  }
  return null;
}

/** For grep/rg/ag/ack: positionals after the pattern are paths. */
function checkGrepPath(args: string[], cwd: string): string | null {
  let patternSeen = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") { i++; break; }
    if (arg.startsWith("-")) {
      i += FLAGS_WITH_VALUE.has(arg) ? 2 : 1;
      continue;
    }
    if (!patternSeen) { patternSeen = true; i++; continue; }
    if (isBlacklisted(arg, cwd)) return arg;
    i++;
  }
  // args after --
  for (; i < args.length; i++) {
    if (isBlacklisted(args[i], cwd)) return args[i];
  }
  return null;
}

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/** Minimal shell tokenizer: splits on whitespace, respects single/double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let esc = false;

  for (const ch of input) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\" && !inSingle) { esc = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (cur) { tokens.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function blocked(tool: string, path: string): { block: true; reason: string } {
  return {
    block: true,
    reason:
      `[search-guard] Blocked: ${tool} on "${path}" is a high-cardinality directory — ` +
      `recursive search would be too slow. Narrow the path to a specific subdirectory.`,
  };
}

const extension: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event, ctx) => {
    const { toolName, input } = event as { toolName: string; input: Record<string, unknown> };
    const cwd = ctx.cwd;

    if (toolName === "bash") {
      const command = input.command as string | undefined;
      if (command) {
        const bad = inspectBashCommand(command, cwd);
        if (bad) return blocked("bash", bad);
      }
      return;
    }

    if (toolName === "grep" || toolName === "find") {
      const path = (input.path as string | undefined) ?? ".";
      if (isBlacklisted(path, cwd)) return blocked(toolName, path);
    }
  });
};

export default extension;
