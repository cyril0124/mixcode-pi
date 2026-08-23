import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveRegisteredModel } from "../core/models.js";
import type { MixCodeModel, MixCodeTabInfo } from "../core/types.js";
import { MIXCODE_FAUX_MODEL } from "./faux-stream.js";
import type { RuntimeModelRegistry } from "./runtime-types.js";

type ModelLookup = RuntimeModelRegistry | ModelRuntime | undefined;

function findModel(lookup: ModelLookup, provider: string, modelId: string) {
  if (!lookup) return undefined;
  if ("find" in lookup && typeof lookup.find === "function") {
    return lookup.find(provider, modelId);
  }
  if ("getModel" in lookup && typeof lookup.getModel === "function") {
    return lookup.getModel(provider, modelId);
  }
  return undefined;
}

/**
 * Built-in catalog lookup for an arbitrary provider/model string pair.
 *
 * `getBuiltinModel` is declared over the generated catalog's literal key unions
 * and as always returning a `Model`, but its implementation is
 * `MODELS[provider]?.[modelId]` — an unregistered provider or model id yields
 * `undefined`. Going through the provider list and `getBuiltinModels` keeps the
 * lookup on public API with no casts and an honest optional result. Catalog
 * keys are the model ids, so this matches `getBuiltinModel` exactly.
 */
function findBuiltinModel(provider: string, modelId: string): MixCodeModel | undefined {
  const builtinProvider = getBuiltinProviders().find((candidate) => candidate === provider);
  if (!builtinProvider) return undefined;
  return getBuiltinModels(builtinProvider).find((model) => model.id === modelId);
}

/** Undefined when provider/model is registered nowhere; callers must handle it. */
export function resolveRuntimeModel(
  provider: string,
  modelId: string,
  modelLookup: ModelLookup,
): MixCodeModel | undefined {
  if (provider === "faux") {
    const id = modelId ? modelId : MIXCODE_FAUX_MODEL.id;
    return { ...MIXCODE_FAUX_MODEL, id };
  }
  const registryModel = findModel(modelLookup, provider, modelId);
  if (registryModel) return registryModel;
  return resolveRegisteredModel(provider, modelId) ?? findBuiltinModel(provider, modelId);
}

export function resolveRuntimeModelFromSession(
  session: SessionManager,
  fallback: MixCodeTabInfo["model"] | MixCodeModel | undefined,
  modelLookup: ModelLookup,
): MixCodeModel {
  const context = session.buildSessionContext();
  if (context.model) {
    const restored = resolveRuntimeModel(
      context.model.provider,
      context.model.modelId,
      modelLookup,
    );
    if (restored) return restored;
  }
  if (fallback && "provider" in fallback) {
    const modelId = "modelId" in fallback ? fallback.modelId : fallback.id;
    const fromFallback = resolveRuntimeModel(fallback.provider, modelId, modelLookup);
    if (fromFallback) return fromFallback;
  }
  // Faux is synthesized, not looked up, so this branch always yields a model.
  return { ...MIXCODE_FAUX_MODEL };
}
