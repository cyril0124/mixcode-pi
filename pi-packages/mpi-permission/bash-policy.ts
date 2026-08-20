import { parse } from "./vendor/unbash.js";
import type { Command, ParsedScript, Redirect, Word, WordPart } from "./vendor/unbash-types.js";

const TRANSPARENT_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
]);

const FILE_COMMANDS: ReadonlySet<string> = new Set([
  ".",
  "source",
  "cd",
  "chdir",
  "popd",
  "pushd",
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  "ls",
  "find",
  "tree",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "du",
  "realpath",
  "readlink",
  "ln",
  "install",
]);

const NESTED_SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

export type BashAnalysis = {
  segments: string[];
  pathArguments: string[];
  dynamicPathArguments: boolean;
  errors: string[];
};

type MutableAnalysis = {
  segments: string[];
  pathArguments: Set<string>;
  dynamicPathArguments: boolean;
  errors: string[];
};

function wordParts(word: Word): readonly WordPart[] {
  return word.parts ?? [];
}

function staticPart(part: WordPart): boolean {
  if (part.type === "Literal" || part.type === "SingleQuoted" || part.type === "AnsiCQuoted") {
    return true;
  }
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    return part.parts.every((child) => child.type === "Literal");
  }
  return false;
}

function knownAutomaticPath(text: string): boolean {
  return /^(?:~|\$HOME|\$PWD)(?:$|[\\/])/.test(text);
}

function staticWord(word: Word): boolean {
  const parts = wordParts(word);
  return parts.length === 0 || parts.every(staticPart) || knownAutomaticPath(word.text);
}

function redirectPath(redirect: Redirect, state: MutableAnalysis): void {
  if (!redirect.target) return;
  if (["<<", "<<-", "<<<", "<&", ">&"].includes(redirect.operator)) return;
  if (!staticWord(redirect.target)) {
    state.dynamicPathArguments = true;
    return;
  }
  state.pathArguments.add(redirect.target.value);
}

function inspectPart(part: WordPart, visit: (script: ParsedScript) => void): void {
  if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
    if (part.script) visit(part.script);
    return;
  }
  if (part.type === "ArithmeticExpansion") {
    visitArithmeticScripts(part.expression, visit);
    return;
  }
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    for (const child of part.parts) inspectPart(child, visit);
    return;
  }
  if (part.type === "ParameterExpansion") {
    if (part.operand) nestedScripts(part.operand, visit);
    for (const child of part.indexParts ?? []) inspectPart(child, visit);
    return;
  }
  if ((part.type === "ExtendedGlob" || part.type === "BraceExpansion") && part.parts) {
    for (const child of part.parts) inspectPart(child, visit);
  }
}

function nestedScripts(word: Word, visit: (script: ParsedScript) => void): void {
  for (const part of wordParts(word)) inspectPart(part, visit);
}

function visitArithmeticScripts(expression: unknown, visit: (script: ParsedScript) => void): void {
  if (!expression || typeof expression !== "object") return;
  const item = expression as Record<string, unknown>;
  if (item.type === "ArithmeticCommandExpansion") {
    if (item.script) visit(item.script as ParsedScript);
    return;
  }
  for (const [key, child] of Object.entries(item)) {
    if (key === "pos" || key === "end") continue;
    visitArithmeticScripts(child, visit);
  }
}

function commandWords(command: Command): Word[] {
  return command.name ? [command.name, ...command.suffix] : [...command.suffix];
}

const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-D",
  "-g",
  "-h",
  "-p",
  "-r",
  "-t",
  "-T",
  "-u",
  "-U",
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);

const WRAPPER_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", SUDO_VALUE_FLAGS],
  ["env", new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"])],
  ["exec", new Set(["-a"])],
]);

const PATH_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-D", "--chdir"])],
  ["env", new Set(["-C", "--chdir"])],
  ["cp", new Set(["-t", "--target-directory"])],
  ["mv", new Set(["-t", "--target-directory"])],
  ["install", new Set(["-t", "--target-directory"])],
]);

function unwrap(words: Word[]): Word[] {
  let start = 0;
  for (;;) {
    const value = words[start]?.value;
    if (!value) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      start++;
      continue;
    }
    if (!TRANSPARENT_PREFIXES.has(value)) break;
    start++;
    while (start < words.length) {
      const option = words[start]!.value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
        start++;
        continue;
      }
      if (!option.startsWith("-") || option === "--") {
        if (option === "--") start++;
        break;
      }
      start++;
      if (WRAPPER_VALUE_FLAGS.get(value)?.has(option) && !option.includes("=")) start++;
    }
  }
  return words.slice(start);
}

function normalized(command: Command): string | null {
  const words = unwrap(commandWords(command));
  const tokens = words.map((word) => word.value);
  for (const redirect of command.redirects) {
    if (redirect.target && (redirect.operator === "<<" || redirect.operator === "<<-")) {
      tokens.push(`${redirect.operator}${redirect.target.value}`);
      continue;
    }
    tokens.push(redirect.operator);
    if (redirect.target) tokens.push(redirect.target.value);
  }
  return tokens.length > 0 ? tokens.join(" ").trim() : null;
}

function addOptionPath(value: string, word: Word, state: MutableAnalysis): void {
  if (!staticWord(word) && !knownAutomaticPath(value)) {
    state.dynamicPathArguments = true;
    return;
  }
  state.pathArguments.add(value);
}

function collectPathOptions(words: Word[], state: MutableAnalysis): void {
  const inspect = (commandWords: Word[]): void => {
    const name = commandWords[0]?.value;
    const options = name ? PATH_VALUE_OPTIONS.get(name) : undefined;
    if (!options) return;
    for (let i = 1; i < commandWords.length; i++) {
      const word = commandWords[i]!;
      for (const option of options) {
        if (word.value === option) {
          const target = commandWords[i + 1];
          if (target) addOptionPath(target.value, target, state);
          i++;
          break;
        }
        const equals = `${option}=`;
        if (word.value.startsWith(equals)) {
          addOptionPath(word.value.slice(equals.length), word, state);
          break;
        }
        if (option.length === 2 && word.value.startsWith(option) && word.value.length > 2) {
          addOptionPath(word.value.slice(option.length), word, state);
          break;
        }
      }
    }
  };

  inspect(words);
  const unwrapped = unwrap(words);
  if (unwrapped[0] !== words[0]) inspect(unwrapped);
}

function collectFileArguments(words: Word[], state: MutableAnalysis): void {
  const unwrapped = unwrap(words);
  const name = unwrapped[0]?.value;
  if (!name || !FILE_COMMANDS.has(name)) return;

  let options = true;
  for (const word of unwrapped.slice(1)) {
    const value = word.value;
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (options && value.startsWith("-")) continue;
    if (options && name === "chmod" && /^(?:[ugoa]*[+-=][rwxXstugo]*|[0-7]{3,4})$/.test(value)) {
      continue;
    }
    if (!staticWord(word)) {
      state.dynamicPathArguments = true;
      continue;
    }
    state.pathArguments.add(value);
  }
}

function staticNestedSource(word: Word, state: MutableAnalysis): string | null {
  if (!staticWord(word)) {
    state.dynamicPathArguments = true;
    return null;
  }
  return word.value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function analyzeEnvSplit(
  source: string,
  trailing: readonly Word[],
  state: MutableAnalysis,
  depth: number,
): void {
  const staticTrailing: string[] = [];
  for (const word of trailing) {
    if (!staticWord(word)) {
      state.dynamicPathArguments = true;
      continue;
    }
    staticTrailing.push(shellQuote(word.value));
  }
  analyzeInto([source, ...staticTrailing].join(" "), state, depth + 1);
}

// Index of the first word after leading env assignments and transparent
// wrappers (stopping before `env` itself, whose -S value would otherwise be
// consumed as a flag argument by the shared skip logic).
function skipWrappers(words: Word[]): number {
  let start = 0;
  for (;;) {
    const value = words[start]?.value;
    if (!value) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      start++;
      continue;
    }
    if (!TRANSPARENT_PREFIXES.has(value) || value === "env") break;
    start++;
    while (start < words.length) {
      const option = words[start]!.value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
        start++;
        continue;
      }
      if (!option.startsWith("-") || option === "--") {
        if (option === "--") start++;
        break;
      }
      start++;
      if (WRAPPER_VALUE_FLAGS.get(value)?.has(option) && !option.includes("=")) start++;
    }
  }
  return start;
}

function collectEnvSplitString(words: Word[], state: MutableAnalysis, depth: number): void {
  const start = skipWrappers(words);
  if (words[start]?.value !== "env") return;
  for (let i = start + 1; i < words.length; i++) {
    const word = words[i]!;
    if (word.value === "-S" || word.value === "--split-string") {
      const nested = words[i + 1];
      if (!nested) return;
      const source = staticNestedSource(nested, state);
      if (source !== null) analyzeEnvSplit(source, words.slice(i + 2), state, depth);
      return;
    }
    for (const option of ["-S", "--split-string="]) {
      if (!word.value.startsWith(option) || word.value.length === option.length) continue;
      const source = word.value.slice(option.length);
      if (!staticWord(word)) state.dynamicPathArguments = true;
      else analyzeEnvSplit(source, words.slice(i + 1), state, depth);
      return;
    }
  }
}

function collectNestedShell(words: Word[], state: MutableAnalysis, depth: number): void {
  const unwrapped = unwrap(words);
  const name = unwrapped[0]?.value;
  if (!name || (!NESTED_SHELLS.has(name) && name !== "eval")) return;
  const commandIndex = unwrapped.findIndex((word, index) => {
    if (index === 0) return false;
    if (word.value === "-c") return true;
    return /^-[^-]*c[^-]*$/.test(word.value);
  });
  if (commandIndex < 0 && name === "eval") {
    // `eval 'cat ../x'` executes its joined static argument as a script.
    const parts: string[] = [];
    for (const word of unwrapped.slice(1)) {
      if (!staticWord(word)) {
        state.dynamicPathArguments = true;
        return;
      }
      parts.push(word.value);
    }
    if (parts.length > 0) analyzeInto(parts.join(" "), state, depth + 1);
    return;
  }
  const nested = commandIndex >= 0 ? unwrapped[commandIndex + 1] : undefined;
  if (!nested) return;
  if (!staticWord(nested)) {
    state.dynamicPathArguments = true;
    return;
  }
  analyzeInto(nested.value, state, depth + 1);
}

function visitValue(value: unknown, state: MutableAnalysis, depth: number): void {
  if (Array.isArray(value)) {
    for (const item of value) visitValue(item, state, depth);
    return;
  }
  if (!value || typeof value !== "object") return;

  const item = value as Record<string, unknown>;
  if (item.type === "Command") {
    const command = item as unknown as Command;
    const name = command.name?.value;
    const segment = normalized(command);
    if (segment) state.segments.push(segment);
    const words = commandWords(command);
    collectPathOptions(words, state);
    collectFileArguments(words, state);
    collectEnvSplitString(words, state, depth);
    collectNestedShell(words, state, depth);
    for (const redirect of command.redirects) {
      redirectPath(redirect, state);
      const heredoc = redirect.operator === "<<" || redirect.operator === "<<-";
      if (heredoc && redirect.target && redirect.body) {
        nestedScripts(redirect.body, (script) => visitValue(script, state, depth + 1));
      }
      const content = redirect.content;
      if (heredoc && content && name && NESTED_SHELLS.has(name)) {
        // `bash -s <<EOF` feeds the heredoc body to a shell as a script.
        analyzeInto(content, state, depth + 1);
      }
      if (redirect.operator === "<<<" && redirect.target) {
        nestedScripts(redirect.target, (script) => visitValue(script, state, depth + 1));
      }
    }
    for (const word of words) nestedScripts(word, (script) => visitValue(script, state, depth + 1));
    for (const assignment of command.prefix) {
      if (assignment.value) {
        nestedScripts(assignment.value, (script) => visitValue(script, state, depth + 1));
      }
      for (const element of assignment.array ?? []) {
        nestedScripts(element, (script) => visitValue(script, state, depth + 1));
      }
      for (const part of assignment.indexParts ?? []) {
        inspectPart(part, (script) => visitValue(script, state, depth + 1));
      }
    }
    return;
  }
  if (
    typeof item.operator === "string" &&
    "target" in item &&
    "fileDescriptor" in item &&
    "variableName" in item
  ) {
    redirectPath(item as unknown as Redirect, state);
    return;
  }
  if (item.type === "ArithmeticCommand") {
    visitArithmeticScripts((item as unknown as { expression: unknown }).expression, (script) =>
      visitValue(script, state, depth + 1),
    );
    return;
  }
  if (item.type === "ArithmeticFor") {
    const arith = item as unknown as { initialize: unknown; test: unknown; update: unknown };
    for (const expression of [arith.initialize, arith.test, arith.update]) {
      visitArithmeticScripts(expression, (script) => visitValue(script, state, depth + 1));
    }
    return;
  }

  if ("text" in item && "value" in item && "parts" in item) {
    nestedScripts(item as unknown as Word, (script) => visitValue(script, state, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(item)) {
    if (key === "pos" || key === "end" || key === "source" || key === "errors") continue;
    visitValue(child, state, depth);
  }
}

function analyzeInto(source: string, state: MutableAnalysis, depth: number): void {
  if (depth >= MAX_ANALYSIS_DEPTH) {
    state.dynamicPathArguments = true;
    state.errors.push("maximum nested script analysis depth exceeded");
    return;
  }
  let script: ParsedScript;
  try {
    script = parse(source);
  } catch (err) {
    state.dynamicPathArguments = true;
    state.errors.push(err instanceof Error ? err.message : String(err));
    return;
  }
  for (const error of script.errors ?? []) state.errors.push(error.message);
  if ((script.errors?.length ?? 0) > 0) state.dynamicPathArguments = true;
  visitValue(script, state, depth);
}

// Policy-level recursion bound for nested `bash -c` / `env -S` scripts. Each
// level re-parses the remaining source, so the cap also bounds the O(n^2)
// worst case that unbash's own MAX_SYNTAX_NESTING cannot see across parses.
// Exceeding the cap reports an error (never silent truncation); the caller
// then also evaluates the raw command as a Bash subject (see
// evaluateToolCallDecisions), so the guard stays fail-closed.
const MAX_ANALYSIS_DEPTH = 32;

/** Parse a Bash script for command-rule subjects and literal path arguments. */
export function analyzeBashCommand(source: string): BashAnalysis {
  const state: MutableAnalysis = {
    segments: [],
    pathArguments: new Set<string>(),
    dynamicPathArguments: false,
    errors: [],
  };
  try {
    analyzeInto(source, state, 0);
  } catch (err) {
    // Fail closed: a parser crash must never present as a clean allow.
    state.dynamicPathArguments = true;
    state.errors.push(err instanceof Error ? err.message : String(err));
  }
  return {
    segments: state.segments,
    pathArguments: [...state.pathArguments],
    dynamicPathArguments: state.dynamicPathArguments,
    errors: state.errors,
  };
}

/** Backward-compatible command subjects used by permission rule matching. */
export function splitBashCommand(source: string): string[] {
  return analyzeBashCommand(source).segments;
}
