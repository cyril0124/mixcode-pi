import { DEFAULT_MODEL_REF } from "./defaults.js";
import { isModelDisabled } from "./mixcode-settings.js";
import type { MixCodeModelRef, MixCodeModel, MixCodeState, MixCodeTabInfo } from "./types.js";

const registeredModels = new Map<string, MixCodeModel>();

export function modelToRef(model: MixCodeModel): MixCodeModelRef {
  return {
    provider: model.provider,
    modelId: model.id,
    displayName: `${model.provider}/${model.id}`,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}

function registerModel(model: MixCodeModel): void {
  registeredModels.set(modelKey(model.provider, model.id), model);
}

export function registerModels(models: MixCodeModel[]): void {
  for (const model of models) registerModel(model);
}

// Drop every previously registered model before re-registering the given set.
// Used by /reload so models removed from models.json stop resolving instead of
// lingering as stale fallbacks in resolveRegisteredModel.
export function replaceRegisteredModels(models: MixCodeModel[]): void {
  registeredModels.clear();
  registerModels(models);
}

// Build the selectable model list shown in the picker: the faux default first,
// followed by every configured model (deduplicated by provider/modelId).
export function buildAvailableModelRefs(configured: MixCodeModelRef[]): MixCodeModelRef[] {
  return configured.reduce(upsertModelRef, [{ ...DEFAULT_MODEL_REF }]);
}

/** Stamp `disabled` on refs from mixcode_settings lists without removing items. */
export function applyDisabledModelFlags(
  models: MixCodeModelRef[],
  disabledProviders: readonly string[] = [],
  disabledModels: readonly string[] = [],
): MixCodeModelRef[] {
  return models.map((model) => {
    const disabled = isModelDisabled(
      model.provider,
      model.modelId,
      disabledProviders,
      disabledModels,
    );
    if (disabled) return { ...model, disabled: true };
    const { disabled: _drop, ...rest } = model;
    return rest;
  });
}

export function assertModelEnabled(model: MixCodeModelRef): void {
  if (model.disabled) {
    throw new Error(
      `Model is disabled: ${model.displayName}. Enable it in /settings then /reload.`,
    );
  }
}

export function isModelRefAvailable(models: MixCodeModelRef[], model: MixCodeModelRef): boolean {
  return models.some(
    (item) => item.provider === model.provider && item.modelId === model.modelId,
  );
}

// Return the canonical ref from the available list (carrying its contextWindow
// etc.) when present; otherwise fall back to the provided ref unchanged.
export function normalizeModelRef(
  models: MixCodeModelRef[],
  model: MixCodeModelRef,
): MixCodeModelRef {
  return (
    models.find((item) => item.provider === model.provider && item.modelId === model.modelId) ??
    model
  );
}

export function resolveRegisteredModel(provider: string, modelId: string): MixCodeModel | undefined {
  return registeredModels.get(modelKey(provider, modelId));
}

export function setStateModel(state: MixCodeState, model: MixCodeModelRef): void {
  state.model = model;
  state.availableModels = upsertModelRef(state.availableModels, model);
}

export function setTabModel(tab: MixCodeTabInfo, model: MixCodeModelRef): void {
  tab.model = model;
  tab.contextLimit = model.contextWindow;
  tab.contextLimitOverridden = false;
}

export function findModelRef(models: MixCodeModelRef[], query: string): MixCodeModelRef {
  const normalized = query.trim();
  const found = models.find(
    (model) =>
      model.displayName === normalized ||
      model.modelId === normalized ||
      modelRefId(model) === normalized,
  );
  if (!found) throw new Error(`Error: Unknown model: ${query}`);
  return found;
}

export function modelRefId(model: MixCodeModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

function upsertModelRef(models: MixCodeModelRef[], model: MixCodeModelRef): MixCodeModelRef[] {
  return [
    ...models.filter((item) => item.provider !== model.provider || item.modelId !== model.modelId),
    model,
  ];
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}
