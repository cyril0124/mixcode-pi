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
  return BLACKLIST.has(resolve(cwd, expandEnvVars(expandTilde(path))));
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return home + p.slice(1);
  }
  return p;
}

/** Expand $HOME and ${HOME} to the actual home directory. */
function expandEnvVars(p: string): string {
  return p.replace(/\$\{HOME\}|\$HOME/g, home);
}

/**
 * Inspect a bash command for dangerous search invocations.
 * Returns the offending path, or null if safe.
 *
 * Handles multiline scripts by stripping heredocs and comments,
 * then splitting on shell command boundaries (newline, pipe, semicolon, &&, ||).
 */
export function inspectBashCommand(command: string, cwd: string): string | null {
  const cleaned = stripHeredocs(command);
  // Split on newlines, pipes, semicolons, and logical operators
  for (const segment of splitShellCommands(cleaned)) {
    const result = checkSegment(segment, cwd);
    if (result) return result;
  }
  return null;
}

/**
 * Strip heredoc bodies so their content is not parsed as commands.
 * Supports: << DELIM ... DELIM, << 'DELIM' ... DELIM, << "DELIM" ... DELIM
 * Also handles <<- (tab-stripped) variants.
 */
function stripHeredocs(input: string): string {
  const lines = input.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match heredoc start: ... <<[-] ['"]?DELIM['"]?
    const heredocMatch = line.match(/<<-?\s*['"]?(\w+)['"]?/);
    if (heredocMatch) {
      const delimiter = heredocMatch[1];
      // Keep the line that starts the heredoc (the command part)
      result.push(line);
      i++;
      // Skip lines until we find the delimiter on its own line
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed === delimiter) {
          i++;
          break;
        }
        i++;
      }
    } else {
      result.push(line);
      i++;
    }
  }
  return result.join("\n");
}

/**
 * Split a shell script into individual command segments.
 * Splits on: \n, |, ;, &&, ||
 * Strips shell comments (# to end of line).
 */
function splitShellCommands(input: string): string[] {
  const segments: string[] = [];
  // First strip comments: replace # to end of line (outside quotes)
  const noComments = stripComments(input);
  // Split on command boundaries: newlines, pipes, semicolons, && and ||
  for (const seg of noComments.split(/\n|&&|\|\||[|;]/)) {
    const trimmed = seg.trim();
    if (trimmed) segments.push(trimmed);
  }
  return segments;
}

/** Strip shell comments (# to end of line) while respecting quotes. */
function stripComments(input: string): string {
  const lines = input.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    result.push(stripLineComment(line));
  }
  return result.join("\n");
}

/** Remove the comment portion from a single line, respecting quotes. */
function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let esc = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && !inSingle) { esc = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "#" && !inSingle && !inDouble) {
      // A # is a comment if preceded by whitespace or at start of line
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

const SEARCH_CMDS = new Set(["grep", "rg", "find", "fd", "ag", "ack"]);

// Flags that consume the next token as a value (grep/rg family).
// Note: bare -E is ERE mode for grep (no value); only rg's -E/--encoding takes a value.
// We omit -E/--encoding here so grep -E is not mis-parsed; rg still checks paths correctly.
const FLAGS_WITH_VALUE = new Set([
  "-e", "-f", "--include", "--exclude", "--exclude-dir",
  "-m", "--max-count", "-A", "-B", "-C", "--context",
  "--color", "--colours", "-g", "--glob", "-t", "--type",
  "--type-add", "--type-not",
  "--max-depth", "--maxdepth", "-d", "--depth",
  "--ignore-file", "--path-separator",
]);

// Flags that already supply the pattern; remaining positionals are all paths.
const PATTERN_FLAGS = new Set(["-e", "--regexp", "-f", "--file"]);

/** grep/rg allow -eFOO / -fFILE / --regexp=FOO / --file=FILE without a separate value token. */
function isAttachedPatternFlag(arg: string): boolean {
  if (arg.startsWith("--regexp=") || arg.startsWith("--file=")) return true;
  if (arg.startsWith("--")) return false;
  return (arg.startsWith("-e") || arg.startsWith("-f")) && arg.length > 2;
}

function checkSegment(segment: string, cwd: string): string | null {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return null;

  // Strip redirections (e.g. 2>/dev/null, >/tmp/out, 2>&1)
  const cleaned = stripRedirections(tokens);
  if (cleaned.length === 0) return null;

  // Skip leading env assignments and sudo
  let i = 0;
  while (i < cleaned.length && (cleaned[i].includes("=") || cleaned[i] === "sudo" || cleaned[i] === "env")) {
    i++;
  }
  if (i >= cleaned.length) return null;

  const cmd = basename(cleaned[i]);
  if (!SEARCH_CMDS.has(cmd)) return null;

  const args = cleaned.slice(i + 1);
  if (cmd === "find") return checkFindPath(args, cwd);
  if (cmd === "fd") return checkFdPath(args, cwd);
  return checkGrepPath(args, cwd);
}

/** Strip shell redirections from the token list. */
function stripRedirections(tokens: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Patterns: 2>/dev/null, >/file, 2>&1, &>/file, 1>/file
    if (/^[0-9]*>[>&]?/.test(t) || /^&>/.test(t)) {
      // If the redirect operator is standalone (e.g. ">" or "2>"), skip next token too
      if (t === ">" || t === "2>" || t === "&>" || t === "1>" || t === ">>" || t === "2>>") {
        i++; // skip the target
      }
      continue;
    }
    // Also handle: < /dev/null, << (but heredocs already stripped)
    if (t === "<" || t === "<<" || t === "<<<") {
      i++; // skip the target
      continue;
    }
    result.push(t);
  }
  return result;
}

/**
 * For find: paths come before any expression token.
 * Expression tokens start with -, !, or (.
 * Check ALL path positionals, not just the first.
 */
function checkFindPath(args: string[], cwd: string): string | null {
  for (const arg of args) {
    // Once we hit an expression token, stop — remaining args are expressions
    if (arg.startsWith("-") || arg === "!" || arg === "(") break;
    if (isBlacklisted(arg, cwd)) return arg;
  }
  return null;
}

/**
 * For fd: usage is `fd [pattern] [path...]`.
 * First positional is the pattern, subsequent positionals are paths.
 */
function checkFdPath(args: string[], cwd: string): string | null {
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
    // Subsequent positionals are paths
    if (isBlacklisted(arg, cwd)) return arg;
    i++;
  }
  // args after --
  for (; i < args.length; i++) {
    if (isBlacklisted(args[i], cwd)) return args[i];
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
      // -e/-f/--regexp/--file already supply the pattern; do not treat next positional as pattern.
      // Also accept attached forms: -eFOO, -fFILE, --regexp=FOO, --file=FILE.
      if (isAttachedPatternFlag(arg)) {
        patternSeen = true;
        i += 1;
        continue;
      }
      if (PATTERN_FLAGS.has(arg)) {
        patternSeen = true;
        i += 2;
        continue;
      }
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
