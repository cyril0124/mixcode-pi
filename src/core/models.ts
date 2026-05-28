import { getModels, getProviders, type Model } from "@earendil-works/pi-ai";
import type { MixCodeModelRef, MixCodeState, MixCodeTabInfo } from "./types.js";

const registeredModels = new Map<string, Model<any>>();

export function modelToRef(model: Model<any>): MixCodeModelRef {
  return {
    provider: model.provider,
    modelId: model.id,
    displayName: `${model.provider}/${model.id}`,
    contextWindow: model.contextWindow,
  };
}

export function listAvailableModelRefs(): MixCodeModelRef[] {
  return mergeModelRefs(
    getProviders().flatMap((provider) => getModels(provider).map(modelToRef)),
    [...registeredModels.values()].map(modelToRef),
  );
}

export function registerModel(model: Model<any>): void {
  registeredModels.set(modelKey(model.provider, model.id), model);
}

export function registerModels(models: Model<any>[]): void {
  for (const model of models) registerModel(model);
}

export function resolveRegisteredModel(provider: string, modelId: string): Model<any> | undefined {
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
  if (!found) throw new Error(`Unknown model: ${query}`);
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

function mergeModelRefs(base: MixCodeModelRef[], extra: MixCodeModelRef[]): MixCodeModelRef[] {
  return extra.reduce(upsertModelRef, base);
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}
