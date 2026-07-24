import type { GuidanceFields } from "./vendor/rpiv-config.js";
import { configPath, loadJsonConfig, validateGuidanceFields } from "./vendor/rpiv-config.js";

interface TodoConfig {
	guidance?: GuidanceFields;
	maxWidgetLines?: number;
	collapseKey?: string;
}

export const DEFAULT_MAX_WIDGET_LINES = 12;
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";
export const COLLAPSE_KEY_OFF = "off";

const FUNCTION_KEYS = new Set(Array.from({ length: 12 }, (_, i) => `f${i + 1}`));
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...FUNCTION_KEYS,
]);
const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

export function loadConfig(): TodoConfig {
	return loadJsonConfig<TodoConfig>(configPath("rpiv-todo"));
}

export function getMaxWidgetLines(): number {
	const lines = loadConfig().maxWidgetLines;
	return typeof lines === "number" && lines >= 3 ? lines : DEFAULT_MAX_WIDGET_LINES;
}

export function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec || spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts.at(-1) ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size || !modifiers.every((modifier) => MODIFIERS.has(modifier))) {
		return false;
	}
	const validBase =
		base.length === 1 ? /[a-z0-9]/.test(base) || SYMBOL_KEYS.has(base) : SPECIAL_KEYS.has(base);
	if (!validBase) return false;
	// pi-tui's runtime matcher rejects modifiers for Escape and function keys.
	return modifiers.length === 0 || (base !== "escape" && base !== "esc" && !FUNCTION_KEYS.has(base));
}

export function resolveCollapseKey(): string {
	const configured = loadConfig().collapseKey;
	const raw = typeof configured === "string" ? configured.trim().toLowerCase() : undefined;
	if (!raw) return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

export { validateGuidanceFields };
