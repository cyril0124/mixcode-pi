import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/**
 * Current account name, so that `~user` resolves for the account owning `home`.
 * `os.userInfo()` throws a SystemError on platforms that expose no user info;
 * an unknown name is safe because `~user` then simply stays untracked.
 */
function readUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

const userName = process.env.USER || process.env.LOGNAME || readUserName();

/** Return true if the resolved path is in the blacklist. */
function isBlacklisted(target: string, cwd: string): boolean {
  return BLACKLIST.has(path.resolve(cwd, expandEnvVars(expandTilde(target))));
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return home + p.slice(1);
  }
  // `~user` names another account's home directory; only the current account is
  // resolvable without reading the password database.
  if (userName !== undefined && (p === `~${userName}` || p.startsWith(`~${userName}/`))) {
    return home + p.slice(1 + userName.length);
  }
  return p;
}

/** Expand $HOME and ${HOME} to the actual home directory. */
function expandEnvVars(p: string): string {
  return p.replace(/\$\{HOME\}|\$HOME/g, home);
}

/** One shell command segment and how its stdin is supplied. */
interface ShellSegment {
  text: string;
  /** stdin comes from an upstream pipe, so the segment does not read the cwd. */
  pipedIn: boolean;
}

/**
 * Inspect a bash command for dangerous search invocations.
 * Returns the offending path, or null if safe.
 *
 * Handles multiline scripts by stripping heredocs and comments,
 * then splitting on shell command boundaries (newline, pipe, semicolon, &&, ||).
 * A `cd` earlier in the script is tracked because it decides what an
 * unqualified search root resolves to.
 */
export function inspectBashCommand(command: string, cwd: string): string | null {
  const cleaned = stripHeredocs(command);
  let effectiveCwd = path.resolve(cwd);
  let cwdMoved = false;

  // Split on newlines, pipes, semicolons, and logical operators
  for (const segment of splitShellCommands(cleaned)) {
    // An unqualified search reads the directory the shell sits in. That directory
    // is only known when this same command moved there via `cd`, and is only
    // dangerous when the move landed on a high-cardinality directory, so the
    // implicit root is checked under exactly those two conditions.
    const implicitRoot =
      cwdMoved && isBlacklisted(effectiveCwd, effectiveCwd) ? effectiveCwd : null;
    const result = checkSegment(segment, effectiveCwd, implicitRoot);
    if (result) return result;

    const moved = applyCd(segment.text, effectiveCwd);
    if (moved !== effectiveCwd) {
      effectiveCwd = moved;
      cwdMoved = true;
    }
  }
  return null;
}

/**
 * Resolve the directory a `cd` segment moves the shell into.
 * Returns `cwd` unchanged for every segment that is not a static `cd`, which
 * includes targets that cannot be resolved statically (`$VAR`, command
 * substitution, `cd -`). An unresolved move leaves the tracked cwd alone rather
 * than guessing one, so it never enables the implicit-root check.
 */
function applyCd(segment: string, cwd: string): string {
  const tokens = stripRedirections(tokenize(segment));
  const cmdIndex = commandIndexOf(tokens);
  if (cmdIndex < 0 || path.posix.basename(tokens[cmdIndex]!) !== "cd") return cwd;

  const operands: string[] = [];
  for (const arg of tokens.slice(cmdIndex + 1)) {
    if (arg === "--") continue;
    if (arg === "-") return cwd; // OLDPWD: not tracked
    if (arg.startsWith("-")) continue; // -P / -L / -e
    operands.push(arg);
  }
  // `cd` with no operand goes to $HOME, which is itself search-guarded.
  const target = operands.length === 0 ? "$HOME" : operands[operands.length - 1]!;
  const expanded = expandEnvVars(expandTilde(target));
  // Non-literal targets stay unresolved; `~user` keeps its tilde after expandTilde.
  if (/[$`(){}[\]*?~]/.test(expanded)) return cwd;
  return path.resolve(cwd, expanded);
}

/** Index of the command token, skipping `VAR=value` prefixes, `sudo`, and `env`. */
function commandIndexOf(tokens: string[]): number {
  return tokens.findIndex((token) => !token.includes("=") && token !== "sudo" && token !== "env");
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
 * Splits on: \n, |, ;, &&, || — but only outside quotes, so a quoted regex
 * alternation (`rg 'foo|bar' /`) is not cut into bogus segments.
 * Strips shell comments (# to end of line).
 */
function splitShellCommands(input: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  const noComments = stripComments(input);
  let cur = "";
  // stdin of the segment being accumulated comes from an upstream `|`.
  let pipedIn = false;
  let inSingle = false;
  let inDouble = false;
  let esc = false;

  const pushSegment = (nextPipedIn: boolean) => {
    const trimmed = cur.trim();
    if (trimmed) segments.push({ text: trimmed, pipedIn });
    cur = "";
    pipedIn = nextPipedIn;
  };

  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i]!;
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
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += ch;
      continue;
    }
    if (inSingle || inDouble) {
      cur += ch;
      continue;
    }
    if (ch === "\n") {
      pushSegment(false);
      continue;
    }
    if (ch === "&" || ch === "|") {
      // && and || split once; a doubled operator adds no empty segment.
      const doubled = noComments[i + 1] === ch;
      if (doubled) i++;
      pushSegment(ch === "|" && !doubled);
      continue;
    }
    if (ch === ";") {
      pushSegment(false);
      continue;
    }
    cur += ch;
  }
  pushSegment(false);
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

function checkSegment(
  segment: ShellSegment,
  cwd: string,
  implicitRoot: string | null,
): string | null {
  const tokens = tokenize(segment.text);
  if (tokens.length === 0) return null;

  // Strip redirections (e.g. 2>/dev/null, >/tmp/out, 2>&1)
  const cleaned = stripRedirections(tokens);
  if (cleaned.length === 0) return null;

  // Skip leading env assignments and sudo
  const cmdIndex = commandIndexOf(cleaned);
  const cmdToken = cmdIndex < 0 ? undefined : cleaned[cmdIndex];
  // Nothing but env assignments / sudo means there is no command to inspect.
  if (cmdToken === undefined) return null;

  const cmd = path.posix.basename(cmdToken);
  if (!SEARCH_CMDS.has(cmd)) return null;

  const args = cleaned.slice(cmdIndex + 1);
  // A search bounded to a shallow depth reads a handful of directory levels,
  // so even a high-cardinality root cannot make it prohibitively slow.
  if (isShallowSearch(cmd, args)) return null;
  // A search whose input is a pipe or a file reads that, not the cwd.
  const root =
    segment.pipedIn || hasStdinRedirect(tokens) || !searchesCwdByDefault(cmd, args)
      ? null
      : implicitRoot;
  if (cmd === "find") return checkFindPath(args, cwd, root);
  if (cmd === "fd") return checkFdPath(args, cwd, root);
  return checkGrepPath(args, cwd, root);
}

/** True when the segment feeds stdin from a file, here-string, or heredoc. */
function hasStdinRedirect(tokens: string[]): boolean {
  return tokens.some((token) => token.startsWith("<") || token.startsWith("0<"));
}

/**
 * True when the command recurses into the current directory given no path operand.
 * `rg`/`fd`/`ag`/`ack` do; `grep` reads stdin unless a recursive flag is present.
 */
function searchesCwdByDefault(cmd: string, args: string[]): boolean {
  if (cmd !== "grep") return true;
  return args.some((arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg));
}

/** Depth-limit flags: `-d`/`--max-depth` (fd, rg) and `-maxdepth` (find). */
const DEPTH_FLAGS: ReadonlySet<string> = new Set(["-d", "--max-depth", "-maxdepth"]);

/** Depth at or below which a bounded search is treated as a cheap listing. */
const SHALLOW_SEARCH_MAX_DEPTH = 2;

/**
 * True when the command bounds its recursion to a shallow depth (`fd -d 1`,
 * `rg --max-depth 2`, `find -maxdepth 1`), which is cheap whatever the root.
 * `grep` is excluded: its `-d` selects a directory action, not a depth.
 */
function isShallowSearch(cmd: string, args: string[]): boolean {
  if (cmd === "grep") return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let depth = DEPTH_FLAGS.has(arg) ? args[i + 1] : undefined;
    if (depth === undefined) {
      // Attached form: `-d1`, `-d=1`, `--max-depth=1`.
      depth = /^(?:-d|--max-depth|-maxdepth)=?(\d+)$/.exec(arg)?.[1];
    }
    if (depth !== undefined && Number(depth) <= SHALLOW_SEARCH_MAX_DEPTH) return true;
  }
  return false;
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
function checkFindPath(args: string[], cwd: string, implicitRoot: string | null): string | null {
  let sawPath = false;
  for (const arg of args) {
    // Once we hit an expression token, stop — remaining args are expressions
    if (arg.startsWith("-") || arg === "!" || arg === "(") break;
    sawPath = true;
    if (isBlacklisted(arg, cwd)) return arg;
  }
  // No path operand: `find` operates on the current directory.
  return sawPath ? null : implicitRoot;
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
  implicitRoot: string | null,
): string | null {
  let pathStart = 0;
  if (!patternFromFlag) {
    if (positionals.length === 0) return implicitRoot;
    if (positionals.length === 1 && isBlacklisted(positionals[0]!, cwd)) {
      return positionals[0]!;
    }
    pathStart = 1;
  }
  for (let j = pathStart; j < positionals.length; j++) {
    if (isBlacklisted(positionals[j]!, cwd)) return positionals[j]!;
  }
  // No path operand: the search root is the cwd.
  return positionals.length <= pathStart ? implicitRoot : null;
}

/** For fd: usage is `fd [pattern] [path...]`. */
function checkFdPath(args: string[], cwd: string, implicitRoot: string | null): string | null {
  // fd's -e is an extension filter (value flag), not a pattern flag.
  const { positionals, patternFromFlag } = collectSearchPositionals(args, {
    patternFlagsSupplyPattern: false,
  });
  return checkPatternThenPaths(positionals, patternFromFlag, cwd, implicitRoot);
}

/** For grep/rg/ag/ack: positionals after the pattern are paths. */
function checkGrepPath(args: string[], cwd: string, implicitRoot: string | null): string | null {
  const { positionals, patternFromFlag } = collectSearchPositionals(args, {
    patternFlagsSupplyPattern: true,
  });
  return checkPatternThenPaths(positionals, patternFromFlag, cwd, implicitRoot);
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
      `[search-guard] Blocked: ${tool} on "${path}" is a high-cardinality directory, ` +
      `so a recursive search would be too slow. Narrow the path to a specific subdirectory.`,
  };
}

/** Block recursive searches of high-cardinality directories in bash/grep/find tool calls. */
export function wireSearchGuard(pi: ExtensionAPI): void {
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
}
