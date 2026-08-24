import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MIXCODE_SETTINGS_FILENAME, loadMixCodeSettings } from "../core/mixcode-settings.js";
import { resolveMixcodeAgentDir, resolveMixcodeStateDir } from "../core/paths.js";
import { createPiModelRegistryBundle } from "../core/pi-models.js";
import {
  applyDisabledModelFlags,
  buildAvailableModelRefs,
  modelRefId,
  modelToRef,
} from "../core/models.js";
import { availableThinkingLevelsForModel } from "../core/thinking-levels.js";

export interface ModelListEntry {
  /** Canonical `provider/modelId`, the value `/models <id>` accepts. */
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  reasoning: boolean;
  /** Stamped from mixcode_settings disabledProviders/disabledModels. */
  disabled: boolean;
  /** Thinking levels this model actually accepts, in `/thinking` order. */
  thinking: ThinkingLevel[];
}

export interface ListModelsCliArgs {
  json?: boolean;
  search?: string;
  help?: boolean;
}

/** Check if CLI argv targets the model listing flag. */
export function isListModelsCliArgs(args: string[]): boolean {
  return args[0] === "--list-models";
}

export function parseListModelsArgs(args: string[]): ListModelsCliArgs {
  let json = false;
  let search: string | undefined;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown list-models argument: ${arg}`);
    if (search !== undefined) throw new Error(`Unexpected argument: ${arg}`);
    search = arg;
  }
  return { json, ...(search === undefined ? {} : { search }) };
}

/**
 * Model catalog as the TUI `/models` picker sees it: configured-auth models from
 * models.json plus the built-in catalog, the faux default first, disabled flags
 * from mixcode_settings, and each model's real thinking levels.
 *
 * Does not load extensions, so providers registered dynamically through
 * `pi.registerProvider` are absent. Never touches the network.
 */
export async function loadModelCatalog(
  options: { agentDir?: string; stateDir?: string; search?: string } = {},
): Promise<ModelListEntry[]> {
  const agentDir = options.agentDir ?? resolveMixcodeAgentDir();
  const stateDir = options.stateDir ?? resolveMixcodeStateDir();
  const settings = await loadMixCodeSettings(path.join(stateDir, MIXCODE_SETTINGS_FILENAME));
  const bundle = await createPiModelRegistryBundle(
    path.join(agentDir, "models.json"),
    path.join(agentDir, "auth.json"),
    { allowModelNetwork: false },
  );
  const configured = bundle.sources
    .filter((source) => source.authStatus.configured)
    .map((source) => modelToRef(source.model));
  const refs = applyDisabledModelFlags(
    buildAvailableModelRefs(configured),
    settings.disabledProviders,
    settings.disabledModels,
  );
  const entries = refs.map((ref) => ({
    id: modelRefId(ref),
    provider: ref.provider,
    modelId: ref.modelId,
    displayName: ref.displayName,
    contextWindow: ref.contextWindow,
    reasoning: ref.reasoning ?? false,
    disabled: ref.disabled === true,
    thinking: availableThinkingLevelsForModel(ref),
  }));
  return filterModelEntries(entries, options.search);
}

/** Same match rule as the `/models <arg>` completion source: id or display name substring. */
export function filterModelEntries(entries: ModelListEntry[], search?: string): ModelListEntry[] {
  const needle = search?.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    (entry) =>
      entry.id.toLowerCase().includes(needle) || entry.displayName.toLowerCase().includes(needle),
  );
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimZero(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimZero(tokens / 1_000)}K`;
  return String(tokens);
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatModelCatalog(entries: ModelListEntry[]): string {
  const rows = entries.map((entry) => [
    entry.provider,
    entry.modelId,
    formatContextWindow(entry.contextWindow),
    entry.thinking.length === 0 ? "-" : entry.thinking.join(","),
    entry.disabled ? "(disabled)" : "",
  ]);
  const header = ["provider", "model", "context", "thinking", ""];
  const widths = header.map((_, column) =>
    Math.max(header[column]!.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

export const LIST_MODELS_HELP = `Usage: mpi --list-models [search] [--json]

List models with configured auth, and the thinking levels each model supports.
Reads models.json/auth.json from the agent dir and mixcode_settings disable
lists; does not start the TUI, load extensions, or use the network. Providers
registered dynamically by extensions (pi.registerProvider) are not included.
`;

export async function runListModelsCommand(
  rawArgs: string[],
  options: { agentDir?: string; stateDir?: string } = {},
): Promise<void> {
  const parsed = parseListModelsArgs(rawArgs);
  if (parsed.help) {
    process.stdout.write(`${LIST_MODELS_HELP}\n`);
    return;
  }
  const catalog = await loadModelCatalog({
    ...options,
    ...(parsed.search === undefined ? {} : { search: parsed.search }),
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return;
  }
  process.stdout.write(catalog.length === 0 ? "" : `${formatModelCatalog(catalog)}\n`);
}
