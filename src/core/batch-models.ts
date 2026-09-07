import type { BatchLuaContext, BatchLuaModelInfo } from "./batch-lua.js";

/**
 * Resolve an exact model id against a batch startup snapshot, without I/O.
 * Canonical references take precedence, including when another model's bare id
 * is identical. Disabled explicit references fail rather than changing routes.
 * Bare ids prefer the startup provider, then the smallest provider by JS string
 * order. Throws for malformed queries or when no enabled candidate exists.
 */
export function resolveBatchModel(query: unknown, context: BatchLuaContext): string {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("Error: Model query must be a non-empty string");
  }
  const normalized = query.trim();
  const disabled = new Set(context.disabledModelIds ?? []);
  let selected: BatchLuaModelInfo | undefined;
  for (const model of context.models ?? []) {
    if (model.id === normalized) {
      if (disabled.has(model.id)) throw new Error(`Error: Model is disabled: ${normalized}`);
      return model.id;
    }
    if (model.modelId !== normalized || disabled.has(model.id)) continue;
    const preferred = model.provider === context.defaultProvider;
    const selectedPreferred = selected?.provider === context.defaultProvider;
    if (
      !selected ||
      (preferred && !selectedPreferred) ||
      (preferred === selectedPreferred && model.provider < selected.provider)
    ) {
      selected = model;
    }
  }
  if (!selected) throw new Error(`Error: No available model matches: ${normalized}`);
  return selected.id;
}
