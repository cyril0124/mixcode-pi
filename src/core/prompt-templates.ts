import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  filePath: string;
  sourceInfo?: PromptTemplateSourceInfo;
}

export interface PromptTemplateSourceInfo {
  scope?: "user" | "project" | "temporary";
  source?: string;
}

/**
 * Load prompt templates from a list of file/directory paths.
 * Each .md file becomes a template with name = filename without extension.
 * Deduplicates by name (first wins).
 */
export function loadPromptTemplates(paths: string[]): PromptTemplate[] {
  const templates: PromptTemplate[] = [];
  for (const rawPath of paths) {
    try {
      const info = statSync(rawPath);
      if (info.isDirectory()) {
        templates.push(...loadTemplatesFromDir(rawPath));
      } else if (info.isFile() && rawPath.endsWith(".md")) {
        const template = loadTemplateFromFile(rawPath);
        if (template) templates.push(template);
      }
    } catch {
      // Skip inaccessible paths
    }
  }
  // Deduplicate by name (first wins)
  const seen = new Map<string, PromptTemplate>();
  for (const template of templates) {
    if (!seen.has(template.name)) seen.set(template.name, template);
  }
  return [...seen.values()];
}

/**
 * Load all .md files from a directory (non-recursive, flat scan).
 */
function loadTemplatesFromDir(dir: string): PromptTemplate[] {
  const templates: PromptTemplate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return templates;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(dir, name);
    try {
      const info = statSync(filePath);
      if (info.isFile() || info.isSymbolicLink()) {
        const template = loadTemplateFromFile(filePath);
        if (template) templates.push(template);
      }
    } catch {
      // Skip inaccessible files
    }
  }
  return templates;
}

/**
 * Load a single template from a .md file.
 * Filename (without .md) becomes the template name.
 * Frontmatter fields: description, argument-hint.
 */
function loadTemplateFromFile(filePath: string): PromptTemplate | null {
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(rawContent);
    const name = basename(filePath).replace(/\.md$/, "");

    let description = stringValue(frontmatter.description) ?? "";
    if (!description) {
      const firstLine = body.split("\n").find((line) => line.trim());
      if (firstLine) {
        description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
      }
    }

    return {
      name,
      description,
      argumentHint: frontmatter["argument-hint"]
        ? String(frontmatter["argument-hint"])
        : undefined,
      content: body,
      filePath,
    };
  } catch {
    return null;
  }
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const yaml = normalized.slice(4, endIndex);
  const parsed = parseYaml(yaml);
  return {
    frontmatter: isRecord(parsed) ? parsed : {},
    body: normalized.slice(endIndex + 4).trimStart(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Expand a prompt template command.
 * If text starts with `/templateName [args]` and matches a known template,
 * substitutes arguments into the template content and returns the expanded text.
 * Returns the original text unchanged if no template matches.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
  if (!text.startsWith("/")) return text;

  const spaceIndex = text.indexOf(" ");
  const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

  const template = templates.find((t) => t.name === templateName);
  if (!template) return text;

  const args = parseCommandArgs(argsString);
  return substituteArgs(template.content, args);
}

/**
 * Parse command arguments with bash-style quoting.
 * Splits on whitespace, respects double and single quotes.
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i]!;
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
    } else if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Substitute argument placeholders in template content.
 * Supports: $1, $2, ..., $@, $ARGUMENTS, ${@:N}, ${@:N:L}
 * Substitution is NOT recursive — argument values are treated as literal text.
 */
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  let result = content;

  // $1, $2, ... positional args (1-indexed)
  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = parseInt(num, 10) - 1;
    return args[index] ?? "";
  });

  // ${@:N} — args from Nth position onwards (1-indexed)
  // ${@:N:L} — L args starting at position N
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    let start = parseInt(startStr as string, 10) - 1;
    if (start < 0) start = 0;
    if (lengthStr) {
      const length = parseInt(lengthStr as string, 10);
      return args.slice(start, start + length).join(" ");
    }
    return args.slice(start).join(" ");
  });

  // $ARGUMENTS — all args joined with spaces
  result = result.replace(/\$ARGUMENTS/g, allArgs);

  // $@ — all args joined with spaces
  result = result.replace(/\$@/g, allArgs);

  return result;
}

// Legacy export for backward compatibility (unused but exported from index.ts)
export function expandLocalPromptCommand(_command: string, _args: string): string | undefined {
  return undefined;
}
