import type { GuidanceFields } from "./vendor/rpiv-config.js";
import { configPath, loadJsonConfig, validateGuidanceFields } from "./vendor/rpiv-config.js";

const CONFIG_PATH = configPath("rpiv-todo");

interface TodoConfig {
	guidance?: GuidanceFields;
}

export function loadConfig(): TodoConfig {
	return loadJsonConfig<TodoConfig>(CONFIG_PATH);
}

export { validateGuidanceFields };
