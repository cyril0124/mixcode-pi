import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const TEMPLATE_DIR = ".pi-goals";
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_OUTPUT_LIMIT = 20_000;

export type GoalTemplate = {
	name: string;
	path: string;
	description?: string;
	aliases: string[];
	allowCommands: boolean;
	commandTimeoutMs: number;
	commandOutputLimit: number;
	body: string;
};

export type GoalTemplateMetadata = {
	name: string;
	path: string;
	description?: string;
	aliases: string[];
	allowCommands: boolean;
	requiredPlaceholders: string[];
	requiredFlags: string[];
	requiresArgs: boolean;
};

export type ResolvedGoalTemplate = {
	name: string;
	path: string;
	objective: string;
	flags: Record<string, string>;
	args: string;
};

export type TemplateResolution = { ok: true; template: ResolvedGoalTemplate } | { ok: false; error: string } | { ok: false; notTemplate: true };

export type GoalTemplateInvocation = {
	name: string;
	flags: Record<string, string>;
	args: string;
};

type Frontmatter = Record<string, string>;

export function discoverGoalTemplates(root = process.cwd()): GoalTemplate[] {
	const templates: GoalTemplate[] = [];
	for (const dir of findTemplateDirs(root)) collectTemplates(root, dir, templates);
	templates.sort((a, b) => a.name.localeCompare(b.name));
	return templates;
}

export function listGoalTemplateMetadata(root = process.cwd()): GoalTemplateMetadata[] {
	return discoverGoalTemplates(root).map((template) => {
		const requiredPlaceholders = findRequiredPlaceholders(template.body);
		return {
			name: template.name,
			path: template.path,
			description: template.description,
			aliases: template.aliases,
			allowCommands: template.allowCommands,
			requiredPlaceholders,
			requiredFlags: requiredPlaceholders.filter((placeholder) => placeholder !== "args"),
			requiresArgs: requiredPlaceholders.includes("args"),
		};
	});
}

export function resolveGoalTemplateByName(nameOrAlias: string, flags: Record<string, string>, args = "", root = process.cwd()): TemplateResolution {
	const matches = findTemplates(nameOrAlias, root);
	if (matches.length > 1) return { ok: false, error: `Ambiguous goal template '${nameOrAlias}' matches: ${matches.map((template) => template.name).join(", ")}.` };
	const template = matches[0];
	if (!template) return { ok: false, notTemplate: true };
	try {
		const values = { ...flags, args };
		const interpolated = interpolate(template.body, values);
		const objective = resolveInlineCommands(interpolated, template, root).trim();
		return { ok: true, template: { name: template.name, path: template.path, objective, flags: { ...flags }, args } };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function findTemplates(nameOrAlias: string, root: string): GoalTemplate[] {
	return discoverGoalTemplates(root).filter((template) => template.name === nameOrAlias || template.aliases.includes(nameOrAlias));
}

function findTemplateDirs(root: string): string[] {
	return [path.join(root, TEMPLATE_DIR), path.join(root, ".ai", TEMPLATE_DIR)].filter(isDirectory);
}

function isDirectory(dirPath: string): boolean {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function collectTemplates(root: string, templateDir: string, templates: GoalTemplate[]): void {
	collectMarkdown(templateDir, (filePath) => {
		// Sync discovery API; Bun.file().text() is async-only.
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = parseFrontmatter(raw);
		const relativeName = stripMarkdownExt(path.relative(templateDir, filePath).split(path.sep).join("/"));
		templates.push({
			name: relativeName,
			path: path.relative(root, filePath),
			description: parsed.frontmatter.description || firstContentLine(parsed.body),
			aliases: parseList(parsed.frontmatter.aliases),
			allowCommands: parseBoolean(parsed.frontmatter.allow_commands),
			commandTimeoutMs: parsePositiveInt(parsed.frontmatter.command_timeout_ms, DEFAULT_COMMAND_TIMEOUT_MS),
			commandOutputLimit: parsePositiveInt(parsed.frontmatter.command_output_limit, DEFAULT_COMMAND_OUTPUT_LIMIT),
			body: parsed.body,
		});
	});
}

function collectMarkdown(dir: string, visit: (filePath: string) => void): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const filePath = path.join(dir, entry);
		let stats: fs.Stats;
		try {
			stats = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (stats.isDirectory()) collectMarkdown(filePath, visit);
		else if ([".md", ".markdown", ".txt"].includes(path.extname(entry))) visit(filePath);
	}
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
	if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
	const end = raw.indexOf("\n---", 4);
	if (end < 0) return { frontmatter: {}, body: raw };
	const frontmatter: Frontmatter = {};
	for (const line of raw.slice(4, end).split(/\r?\n/)) {
		const [, key, value] = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/) ?? [];
		// A line without both captures is not a frontmatter entry and is skipped.
		if (key !== undefined && value !== undefined) frontmatter[key] = stripQuotes(value.trim());
	}
	return { frontmatter, body: raw.slice(end + 4).replace(/^\r?\n/, "") };
}

export function parseGoalTemplateInvocation(input: string): GoalTemplateInvocation | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	const [, name, remainder] = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
	// Without a leading name token the invocation is unusable.
	if (name === undefined) return undefined;
	let rest = remainder ?? "";
	let args = "";
	if (rest.startsWith("-- ")) {
		args = rest.slice(3).trim();
		rest = "";
	} else {
		const delimiter = rest.indexOf(" -- ");
		if (delimiter >= 0) {
			args = rest.slice(delimiter + 4).trim();
			rest = rest.slice(0, delimiter).trim();
		}
	}
	return { name, flags: parseFlags(rest), args };
}

function parseFlags(input: string): Record<string, string> {
	const values: Record<string, string> = {};
	const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	let consumedByPreviousFlag = false;
	for (const [index, raw] of tokens.entries()) {
		if (consumedByPreviousFlag) {
			consumedByPreviousFlag = false;
			continue;
		}
		const token = unquote(raw);
		if (!token.startsWith("--")) continue;
		const eq = token.indexOf("=");
		if (eq > 2) {
			values[token.slice(2, eq)] = token.slice(eq + 1);
			continue;
		}
		const lookahead = tokens[index + 1];
		// A following non-flag token is the flag value; otherwise the flag is a boolean switch.
		if (lookahead !== undefined && !lookahead.startsWith("--")) {
			values[token.slice(2)] = unquote(lookahead);
			consumedByPreviousFlag = true;
		} else {
			values[token.slice(2)] = "true";
		}
	}
	return values;
}

function interpolate(text: string, values: Record<string, string>): string {
	return text.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key: string) => {
		const value = values[key];
		if (value === undefined) throw new Error(`Missing template value for {{${key}}}.`);
		return value;
	});
}

function findRequiredPlaceholders(text: string): string[] {
	const placeholders = new Set<string>();
	for (const [, name] of text.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)) {
		if (name !== undefined) placeholders.add(name);
	}
	return [...placeholders].sort();
}

function resolveInlineCommands(text: string, template: GoalTemplate, cwd: string): string {
	return text.replace(/!`([^`]+)`/g, (_match, command: string) => {
		if (!template.allowCommands) throw new Error(`Template ${template.name} uses inline commands but allow_commands is not true.`);
		return runCommand(command, template, cwd);
	});
}

function runCommand(command: string, template: GoalTemplate, cwd: string): string {
	try {
		// node:child_process — pure pi runs on Node; Bun.spawnSync is unavailable there.
		const result = spawnSync("/bin/bash", ["-lc", command], {
			cwd,
			encoding: "utf8",
			timeout: template.commandTimeoutMs,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			const errText = result.stderr || result.stdout || `exit ${result.status}`;
			throw new Error(errText.trim() || `exit ${result.status}`);
		}
		const output = result.stdout ?? "";
		return output.length > template.commandOutputLimit ? `${output.slice(0, template.commandOutputLimit)}\n[output truncated]` : output;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Inline command failed in template ${template.name}: ${message}`);
	}
}

function stripMarkdownExt(filePath: string): string {
	return filePath.replace(/\.(md|markdown|txt)$/i, "");
}

function parseList(value?: string): string[] {
	if (!value) return [];
	return value.replace(/^\[|\]$/g, "").split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
}

function parseBoolean(value?: string): boolean {
	return value === "true" || value === "yes" || value === "1";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstContentLine(body: string): string | undefined {
	return body.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
}

function stripQuotes(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function unquote(value: string): string {
	return stripQuotes(value);
}
