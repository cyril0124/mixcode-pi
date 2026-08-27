import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * High-cardinality directories that must never be used as search roots.
 * Searching these recursively is prohibitively slow.
 *
 * In addition to the static list, we dynamically add:
 * - (process.env.HOME || os.homedir())        e.g. /nfs/home/alice
 * - path.dirname(home)  e.g. /nfs/home  (covers non-standard home prefixes)
 */
const home = process.env.HOME || os.homedir();
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
  path.dirname(home),
]);

/** Return true if the resolved path is in the blacklist. */
function isBlacklisted(target: string, cwd: string): boolean {
  return BLACKLIST.has(path.resolve(cwd, expandEnvVars(expandTilde(target))));
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
  const result: string[] = [];
  // Non-null while inside a heredoc body; those lines are dropped up to and including the delimiter.
  let openDelimiter: string | null = null;

  for (const line of input.split("\n")) {
    if (openDelimiter !== null) {
      if (line.trim() === openDelimiter) openDelimiter = null;
      continue;
    }
    // Match heredoc start: ... <<[-] ['"]?DELIM['"]?
    const heredocMatch = line.match(/<<-?\s*['"]?(\w+)['"]?/);
    // An unterminated heredoc leaves openDelimiter set, so the rest of the script stays stripped.
    openDelimiter = heredocMatch?.[1] ?? null;
    // Keep the line that starts the heredoc (the command part)
    result.push(line);
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
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      esc = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "#" && !inSingle && !inDouble) {
      // A # is a comment if preceded by whitespace or at start of line
      // charAt returns "" past the start of the line, which is not whitespace.
      if (i === 0 || /\s/.test(line.charAt(i - 1))) {
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
  "-e",
  "-f",
  "--include",
  "--exclude",
  "--exclude-dir",
  "-m",
  "--max-count",
  "-A",
  "-B",
  "-C",
  "--context",
  "--color",
  "--colours",
  "-g",
  "--glob",
  "-t",
  "--type",
  "--type-add",
  "--type-not",
  "--max-depth",
  "--maxdepth",
  "-d",
  "--depth",
  "--ignore-file",
  "--path-separator",
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
  const cmdIndex = cleaned.findIndex(
    (token) => !token.includes("=") && token !== "sudo" && token !== "env",
  );
  const cmdToken = cmdIndex < 0 ? undefined : cleaned[cmdIndex];
  // Nothing but env assignments / sudo means there is no command to inspect.
  if (cmdToken === undefined) return null;

  const cmd = path.posix.basename(cmdToken);
  if (!SEARCH_CMDS.has(cmd)) return null;

  const args = cleaned.slice(cmdIndex + 1);
  if (cmd === "find") return checkFindPath(args, cwd);
  if (cmd === "fd") return checkFdPath(args, cwd);
  return checkGrepPath(args, cwd);
}

/** Strip shell redirections from the token list. */
function stripRedirections(tokens: string[]): string[] {
  const result: string[] = [];
  // Set when the previous token was a standalone redirect operator whose target follows.
  let skipTarget = false;
  for (const t of tokens) {
    if (skipTarget) {
      skipTarget = false;
      continue;
    }
    // Patterns: 2>/dev/null, >/file, 2>&1, &>/file, 1>/file
    if (/^[0-9]*>[>&]?/.test(t) || /^&>/.test(t)) {
      // If the redirect operator is standalone (e.g. ">" or "2>"), skip next token too
      skipTarget = t === ">" || t === "2>" || t === "&>" || t === "1>" || t === ">>" || t === "2>>";
      continue;
    }
    // Also handle: < /dev/null, << (but heredocs already stripped)
    if (t === "<" || t === "<<" || t === "<<<") {
      skipTarget = true;
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
 * Collect positionals and whether -e/-f already supplied the pattern.
 * Value flags (-g, -t, -e for fd, …) are skipped with their values.
 */
function collectSearchPositionals(
  args: string[],
  options: { patternFlagsSupplyPattern: boolean },
): { positionals: string[]; patternFromFlag: boolean } {
  const positionals: string[] = [];
  let patternFromFlag = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("-")) {
      if (options.patternFlagsSupplyPattern) {
        if (isAttachedPatternFlag(arg)) {
          patternFromFlag = true;
          i += 1;
          continue;
        }
        if (PATTERN_FLAGS.has(arg)) {
          patternFromFlag = true;
          i += 2;
          continue;
        }
      }
      i += FLAGS_WITH_VALUE.has(arg) ? 2 : 1;
      continue;
    }
    positionals.push(arg);
    i++;
  }
  for (; i < args.length; i++) positionals.push(args[i]!);
  return { positionals, patternFromFlag };
}

/**
 * First positional is pattern unless pattern already came from flags.
 * Exception: sole positional that is a blacklisted root is treated as a path
 * (e.g. `rg -g '*.ts' /`, `fd -e ts /`, bare `rg /`) — otherwise the root is
 * misread as the pattern and never path-checked.
 */
function checkPatternThenPaths(
  positionals: string[],
  patternFromFlag: boolean,
  cwd: string,
): string | null {
  let pathStart = 0;
  if (!patternFromFlag) {
    if (positionals.length === 0) return null;
    if (positionals.length === 1 && isBlacklisted(positionals[0]!, cwd)) {
      return positionals[0]!;
    }
    pathStart = 1;
  }
  for (let j = pathStart; j < positionals.length; j++) {
    if (isBlacklisted(positionals[j]!, cwd)) return positionals[j]!;
  }
  return null;
}

/** For fd: usage is `fd [pattern] [path...]`. */
function checkFdPath(args: string[], cwd: string): string | null {
  // fd's -e is an extension filter (value flag), not a pattern flag.
  const { positionals, patternFromFlag } = collectSearchPositionals(args, {
    patternFlagsSupplyPattern: false,
  });
  return checkPatternThenPaths(positionals, patternFromFlag, cwd);
}

/** For grep/rg/ag/ack: positionals after the pattern are paths. */
function checkGrepPath(args: string[], cwd: string): string | null {
  const { positionals, patternFromFlag } = collectSearchPositionals(args, {
    patternFlagsSupplyPattern: true,
  });
  return checkPatternThenPaths(positionals, patternFromFlag, cwd);
}

/** Minimal shell tokenizer: splits on whitespace, respects single/double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let esc = false;

  for (const ch of input) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      esc = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
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
